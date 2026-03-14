const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const bodyParser = require("body-parser");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

const users = {};

app.use(bodyParser.json());
app.use(express.static("public"));

app.post("/register", (req, res) => {
  const { nick, password } = req.body;

  if (!nick || !password)
    return res.json({ error: "Заполните поля" });

  if (users[nick])
    return res.json({ error: "Ник занят" });

  users[nick] = password;

  res.json({ success: true });
});

app.post("/login", (req, res) => {
  const { nick, password } = req.body;

  if (!users[nick] || users[nick] !== password)
    return res.json({ error: "Неверный ник или пароль" });

  res.json({ success: true });
});

io.on("connection", (socket) => {

  socket.on("chat message", (msg) => {
    io.emit("chat message", msg);
  });

});

server.listen(PORT, () =>
  console.log(`Server running on ${PORT}`)
);