const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

// Загрузка базы
let db = { chats: {}, contacts: {}, onlineUsers: [] };
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE));

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

app.use(express.json());
app.use(express.static("public"));

io.on("connection", (socket) => {
  socket.nick = "";
  socket.friend = "";

  // подключение к чату
  socket.on("join", (data) => {
    socket.nick = data.nick;
    socket.friend = data.friend;

    if (!db.contacts[socket.nick]) db.contacts[socket.nick] = [];
    if (!db.contacts[socket.nick].includes(socket.friend))
      db.contacts[socket.nick].push(socket.friend);

    if (!db.onlineUsers.includes(socket.nick)) db.onlineUsers.push(socket.nick);

    const key = [socket.nick, socket.friend].sort().join("|");
    if (!db.chats[key]) db.chats[key] = [];

    // отправляем историю и контакты
    socket.emit("chat history", db.chats[key]);
    io.emit("update contacts", db.contacts);
    io.emit("update online", db.onlineUsers);

    saveDB();
  });

  // отправка текстового сообщения
  socket.on("message", (msg) => {
    const key = [socket.nick, socket.friend].sort().join("|");
    const message = { id: Date.now(), from: socket.nick, text: msg };
    db.chats[key].push(message);
    saveDB();
    io.emit("new message", { ...message, to: socket.friend, chatKey: key });
  });

  // отправка картинки
  socket.on("image", (img) => {
    const key = [socket.nick, socket.friend].sort().join("|");
    const message = { id: Date.now(), from: socket.nick, image: img.data };
    db.chats[key].push(message);
    saveDB();
    io.emit("image", { ...message, to: socket.friend, chatKey: key });
  });

  // удаление сообщения
  socket.on("delete message", (msgId) => {
    const key = [socket.nick, socket.friend].sort().join("|");
    db.chats[key] = db.chats[key].filter(m => m.id !== msgId);
    saveDB();
    io.emit("message deleted", { id: msgId, chatKey: key });
  });

  // удаление контакта
  socket.on("remove contact", (contact) => {
    if (db.contacts[socket.nick]) {
      db.contacts[socket.nick] = db.contacts[socket.nick].filter(c => c !== contact);
      saveDB();
      io.emit("update contacts", db.contacts);
    }
  });

  // отключение
  socket.on("disconnect", () => {
    db.onlineUsers = db.onlineUsers.filter(u => u !== socket.nick);
    io.emit("update online", db.onlineUsers);
  });
});

server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));