const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

// Простое хранилище пользователей и сообщений
const users = {}; // { nick: password }
let onlineUsers = []; // массив ников
let messages = {}; // { "user1|user2": [{from, msg}] }
let contacts = {}; // { nick: [friends...] }

app.use(express.json());
app.use(express.static("public"));

// Регистрация
app.post("/register", (req, res) => {
  const { nick, password } = req.body;
  if (!nick || !password) return res.json({ error: "Заполните поля" });
  if (users[nick]) return res.json({ error: "Такой ник уже существует" });
  users[nick] = password;
  if (!contacts[nick]) contacts[nick] = [];
  res.json({ success: true });
});

// Вход
app.post("/login", (req, res) => {
  const { nick, password } = req.body;
  if (!nick || !password) return res.json({ error: "Заполните поля" });
  if (!users[nick] || users[nick] !== password)
    return res.json({ error: "Неверный ник или пароль" });
  res.json({ success: true });
});

// Socket.io
io.on("connection", (socket) => {
  let nick = "";
  let friend = "";

  socket.on("join", (data) => {
    nick = data.nick;
    friend = data.friend;

    if (!onlineUsers.includes(nick)) onlineUsers.push(nick);
    if (!contacts[nick]) contacts[nick] = [];
    if (friend && !contacts[nick].includes(friend)) contacts[nick].push(friend);

    const key = [nick, friend].sort().join("|");
    if (!messages[key]) messages[key] = [];

    socket.emit("chat history", messages[key]);
    io.emit("update contacts", contacts);
    io.emit("update online", onlineUsers);
  });

  // Отправка сообщений
  socket.on("message", msg => {
    const key = [nick, friend].sort().join("|");
    const message = { id: Date.now(), from: nick, msg };
    messages[key].push(message);
    io.emit("new message", { ...message, to: friend, chatKey: key });
  });

  // Удаление сообщений
  socket.on("delete message", id=>{
    const key = [nick, friend].sort().join("|");
    messages[key] = messages[key].filter(m=>m.id!==id);
    io.emit("message deleted", {id, chatKey:key});
  });

  // Удаление контактов
  socket.on("remove contact", c=>{
    if(contacts[nick]) contacts[nick] = contacts[nick].filter(f=>f!==c);
    io.emit("update contacts", contacts);
  });

  socket.on("disconnect", () => {
    onlineUsers = onlineUsers.filter((u) => u !== nick);
    io.emit("update online", onlineUsers);
  });
});

server.listen(PORT, () => console.log("Сервер запущен на порту " + PORT));