const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;

/* ---------- ВСТАВЬ СВОЙ URL И КЛЮЧ ---------- */
const supabaseUrl = "https://ghpdifuinyyhynqksrnw.supabase.co";       // пример: https://xyzabc.supabase.co
const supabaseKey = "sb_publishable_kSV1uMXLzCr2A6hQXoV70g_vti-szE_";  // пример: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
const supabase = createClient(supabaseUrl, supabaseKey);

/* ---------- НАСТРОЙКИ ---------- */
app.use(bodyParser.json());
app.use(express.static("public"));

/* ---------- РЕГИСТРАЦИЯ ---------- */
app.post("/register", (req, res) => {
  const { nick, password } = req.body;
  if (!nick || !password) return res.json({ error: "Заполните поля" });

  supabase
    .from("users")
    .select("*")
    .eq("nick", nick)
    .then(response => {
      if (response.data.length > 0) return res.json({ error: "Ник занят" });

      supabase
        .from("users")
        .insert([{ nick, password }])
        .then(() => res.json({ success: true }))
        .catch(() => res.json({ error: "Ошибка при сохранении пользователя" }));
    })
    .catch(() => res.json({ error: "Ошибка базы данных" }));
});

/* ---------- ВХОД ---------- */
app.post("/login", (req, res) => {
  const { nick, password } = req.body;
  if (!nick || !password) return res.json({ error: "Заполните поля" });

  supabase
    .from("users")
    .select("*")
    .eq("nick", nick)
    .eq("password", password)
    .then(response => {
      if (!response.data || response.data.length === 0)
        return res.json({ error: "Неверный ник или пароль" });
      res.json({ success: true });
    })
    .catch(() => res.json({ error: "Ошибка базы данных" }));
});

/* ---------- СПИСОК КОНТАКТОВ ---------- */
app.get("/users", (req, res) => {
  supabase
    .from("users")
    .select("nick")
    .then(response => {
      const users = response.data || [];
      res.json(users.map(u => u.nick));
    })
    .catch(() => res.json([]));
});

/* ---------- ЗАГРУЗКА СООБЩЕНИЙ ---------- */
app.get("/messages", (req, res) => {
  supabase
    .from("messages")
    .select("*")
    .order("id", { ascending: true })
    .then(response => res.json(response.data || []))
    .catch(() => res.json([]));
});

/* ---------- SOCKET.IO ---------- */
io.on("connection", (socket) => {
  let nick = "";

  socket.on("set nick", (n) => {
    nick = n;
  });

  socket.on("private message", (data) => {
    const { fromNick, toNick, msg } = data;

    supabase
      .from("messages")
      .insert([{ from: fromNick, to: toNick, text: msg }])
      .then(() => io.emit("private message", data))
      .catch(err => console.error("Ошибка при сохранении сообщения:", err));
  });

  socket.on("disconnect", () => {});
});

/* ---------- ЗАПУСК СЕРВЕРА ---------- */
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});