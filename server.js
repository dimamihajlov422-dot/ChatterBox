const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Простейшее хранение сообщений
const DB_FILE = path.join(__dirname, "db.json");
let db = { chats: {} };

// Читаем файл при старте
if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE));
}

// Сохраняем в файл
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
        // Отправляем историю чата
        socket.emit("chat history", db.chats[key]);
    });

    socket.on("message", (msg) => {
        const key = [nick, friend].sort().join("|");
        const message = { from: nick, text: msg, time: Date.now() };
        if (!db.chats[key]) db.chats[key] = [];
        db.chats[key].push(message);
        saveDB();
        // Отправляем сообщение всем участникам
        io.emit("new message", { ...message, to: friend });
    });
});

server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));