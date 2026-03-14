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
let db = { chats: {} };

// Читаем базу
if (fs.existsSync(DB_FILE)) {
  db = JSON.parse(fs.readFileSync(DB_FILE));
}

// Сохраняем базу
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
    const key = [nick, friend].sort().join("|");
    if (!db.chats[key]) db.chats[key] = [];
    // отправляем историю
    socket.emit("chat history", db.chats[key]);

    // обновляем контакты
    const contacts = Object.keys(db.chats)
      .map(k => k.split("|").filter(u => u !== nick)[0])
      .filter(Boolean);
    socket.emit("update contacts", contacts);
  });

  socket.on("message", (msg) => {
    const key = [nick, friend].sort().join("|");
    const message = { id: Date.now(), from: nick, text: msg };
    if (!db.chats[key]) db.chats[key] = [];
    db.chats[key].push(message);
    saveDB();
    io.emit("new message", { ...message, to: friend });
  });

  socket.on("delete message", (msgId) => {
    const key = [nick, friend].sort().join("|");
    db.chats[key] = db.chats[key].filter(m => m.id !== msgId);
    saveDB();
    io.emit("message deleted", { id: msgId, chatKey: key });
  });
});

server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));