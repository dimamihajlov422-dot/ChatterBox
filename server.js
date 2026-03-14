const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;

/* ---------- SUPABASE ---------- */
const supabaseUrl = "ТВОЙ_PROJECT_URL";
const supabaseKey = "ТВОЙ_ANON_KEY";
const supabase = createClient(supabaseUrl, supabaseKey);

/* ---------- НАСТРОЙКИ ---------- */
app.use(bodyParser.json());
app.use(express.static("public"));

/* ---------- РЕГИСТРАЦИЯ ---------- */
app.post("/register", async (req, res) => {
  const { nick, password } = req.body;

  if (!nick || !password) return res.json({ error: "Заполните поля" });

  const { data: existing } = await supabase
    .from("users")
    .select("*")
    .eq("nick", nick);

  if (existing.length > 0) return res.json({ error: "Ник занят" });

  await supabase.from("users").insert([{ nick, password }]);
  res.json({ success: true });
});

/* ---------- ВХОД ---------- */
app.post("/login", async (req, res) => {
  const { nick, password } = req.body;

  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("nick", nick)
    .eq("password", password);

  if (user.length === 0) return res.json({ error: "Неверный ник или пароль" });

  res.json({ success: true });
});

/* ---------- СПИСОК КОНТАКТОВ ---------- */
app.get("/users", async (req, res) => {
  const { data: users } = await supabase.from("users").select("nick");
  res.json(users.map(u => u.nick));
});

/* ---------- ЗАГРУЗКА СООБЩЕНИЙ ---------- */
app.get("/messages", async (req, res) => {
  const { data: messages } = await supabase.from("messages").select("*");
  res.json(messages);
});

/* ---------- SOCKET.IO ---------- */
io.on("connection", (socket) => {

  socket.on("chat message", async (msg) => {
    // Сохраняем в базу
    await supabase.from("messages").insert([{ text: msg }]);
    // Отправляем всем
    io.emit("chat message", msg);
  });

});

/* ---------- ЗАПУСК СЕРВЕРА ---------- */
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});