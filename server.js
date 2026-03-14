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

// Socket.io
io.on("connection", (socket) => {
  let nick = "";
  let friend = "";

  socket.on("join", (data) => {
    nick = data.nick;
    friend = data.friend;

    if (!db.contacts[nick]) db.contacts[nick] = [];
    if (!db.contacts[nick].includes(friend)) db.contacts[nick].push(friend);

    const key = [nick, friend].sort().join("|");
    if (!db.chats[key]) db.chats[key] = [];

    // добавляем в онлайн
    if (!db.onlineUsers.includes(nick)) db.onlineUsers.push(nick);

    socket.emit("chat history", db.chats[key]);
    io.emit("update contacts", db.contacts);
    io.emit("update online", db.onlineUsers);
    saveDB();
  });

  socket.on("message", (msg) => {
    const key = [nick, friend].sort().join("|");
    const message = { id: Date.now(), from: nick, text: msg };
    db.chats[key].push(message);
    saveDB();
    io.emit("new message", { ...message, to: friend });
  });

  socket.on("image", (img) => {
    const key = [nick, friend].sort().join("|");
    const message = { id: Date.now(), from: nick, image: img.data };
    db.chats[key].push(message);
    saveDB();
    io.emit("image", { ...message, to: friend });
  });

  socket.on("delete message", (msgId) => {
    const key = [nick, friend].sort().join("|");
    db.chats[key] = db.chats[key].filter(m => m.id !== msgId);
    saveDB();
    io.emit("message deleted", { id: msgId, chatKey: key });
  });

  socket.on("remove contact", (contact) => {
    if (db.contacts[nick]) {
      db.contacts[nick] = db.contacts[nick].filter(c => c !== contact);
      saveDB();
      io.emit("update contacts", db.contacts);
    }
  });

  socket.on("disconnect", () => {
    db.onlineUsers = db.onlineUsers.filter(u => u !== nick);
    io.emit("update online", db.onlineUsers);
  });
});

server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));