const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const bodyParser = require("body-parser");

const PORT = process.env.PORT || 3000;

// Простое хранилище пользователей и сообщений
const users = {}; // { nick: password }
let onlineUsers = []; // массив ников
let messages = {}; // { "user1|user2": [{from, msg}] }

app.use(bodyParser.json());
app.use(express.static("public"));

// Регистрация
app.post("/register", (req, res) => {
  const { nick, password } = req.body;
  if (!nick || !password) return res.json({ error: "Заполните поля" });
  if (users[nick]) return res.json({ error: "Такой ник уже существует" });
  users[nick] = password;
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

  socket.on("set nick", (n) => {
    nick = n;
    if (!onlineUsers.includes(nick)) onlineUsers.push(nick);
    io.emit("update users", onlineUsers);
  });

  socket.on("private message", (data) => {
    const key =
      [data.fromNick, data.toNick].sort().join("|"); // одинаковый ключ для двоих
    if (!messages[key]) messages[key] = [];
    messages[key].push({ from: data.fromNick, msg: data.msg });
    io.to(socket.id).emit("private message", data);
    socket.broadcast.emit("private message", data);
  });

  socket.on("disconnect", () => {
    onlineUsers = onlineUsers.filter((u) => u !== nick);
    io.emit("update users", onlineUsers);
  });
});

http.listen(PORT, () => console.log(Сервер запущен на порту ${PORT}));