const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const bodyParser = require("body-parser");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

/* ---------- ПАМЯТЬ ---------- */

let data = { users: {}, messages: [] };

if (fs.existsSync("data.json")) {
  data = JSON.parse(fs.readFileSync("data.json"));
}

function save() {
  fs.writeFileSync("data.json", JSON.stringify(data, null, 2));
}

/* ---------- НАСТРОЙКИ ---------- */

app.use(bodyParser.json());
app.use(express.static("public"));

/* ---------- РЕГИСТРАЦИЯ ---------- */

app.post("/register", (req, res) => {
  const { nick, password } = req.body;

  if (!nick || !password)
    return res.json({ error: "Заполните поля" });

  if (data.users[nick])
    return res.json({ error: "Ник уже существует" });

  data.users[nick] = password;

  save();

  res.json({ success: true });
});

/* ---------- ВХОД ---------- */

app.post("/login", (req, res) => {
  const { nick, password } = req.body;

  if (!data.users[nick] || data.users[nick] !== password)
    return res.json({ error: "Неверный ник или пароль" });

  res.json({ success: true });
});

/* ---------- СПИСОК КОНТАКТОВ ---------- */

app.get("/users", (req, res) => {
  res.json(Object.keys(data.users));
});

/* ---------- SOCKET.IO ---------- */

io.on("connection", (socket) => {

  socket.on("chat message", (msg) => {

    data.messages.push(msg);

    save();

    io.emit("chat message", msg);

  });

});

/* ---------- ЗАПУСК ---------- */

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});