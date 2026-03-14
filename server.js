const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bodyParser = require("body-parser");
const { nanoid } = require("nanoid");
const { Low, JSONFile } = require("lowdb");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.json());
app.use(express.static("public"));

// --- LowDB настройка ---
const file = path.join(__dirname, "db.json");
const adapter = new JSONFile(file);
const db = new Low(adapter);

async function initDB() {
  await db.read();
  db.data = db.data || { chats: {} }; // { chatId: [{from, msg}] }
  await db.write();
}
initDB();

// Создание нового чата
app.get("/new-chat", async (req, res) => {
  const chatId = nanoid(6);
  db.data.chats[chatId] = [];
  await db.write();
  res.json({ chatId });
});

io.on("connection", (socket) => {
  let currentChat = null;
  let nick = null;

  socket.on("join chat", async (data) => {
    currentChat = data.chatId;
    nick = data.nick || `Anon_${nanoid(3)}`;
    socket.join(currentChat);

    await db.read();
    const msgs = db.data.chats[currentChat] || [];
    socket.emit("chat history", msgs);
  });

  socket.on("private message", async (msg) => {
    if (!currentChat) return;
    const message = { from: nick, msg };

    await db.read();
    if (!db.data.chats[currentChat]) db.data.chats[currentChat] = [];
    db.data.chats[currentChat].push(message);
    await db.write();

    io.to(currentChat).emit("private message", message);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));