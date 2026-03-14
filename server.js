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
const supabaseUrl = "https://ghpdifuinyyhynqksrnw.supabase.co"; // например https://xyzabc.supabase.co
const supabaseKey = "sb_publishable_kSV1uMXLzCr2A6hQXoV70g_vti-szE_";
const supabase = createClient(supabaseUrl, supabaseKey);

/* ---------- НАСТРОЙКИ ---------- */
app.use(bodyParser.json());
app.use(express.static("public"));

/* ---------- РЕГИСТРАЦИЯ ---------- */
app.post("/register", async (req, res) => {
  const { nick, password } = req.body;
  if (!nick || !password) return res.json({ error: "Заполните поля" });

  const existingResp = await supabase
    .from("users")
    .select("*")
    .eq("nick", nick);

  const existing = existingResp.data;

  if (existing.length > 0) return res.json({ error: "Ник занят" });

  await supabase.from("users").insert([{ nick, password }]);
  res.json({ success: true });
});

/* ---------- ВХОД ---------- */
app.post("/login", async (req, res) => {
  const { nick, password } = req.body;

  const loginResp = await supabase
    .from("users")
    .select("*")
    .eq("nick", nick)
    .eq("password", password);

  const user = loginResp.data;

  if (!user || user.length === 0) return res.json({ error: "Неверный ник или пароль" });

  res.json({ success: true });
});

/* ---------- СПИСОК КОНТАКТОВ ---------- */
app.get("/users", async (req, res) => {
  const usersResp = await supabase.from("users").select("nick");
  const users = usersResp.data;
  res.json(users.map(u => u.nick));
});

/* ---------- ЗАГРУЗКА СООБЩЕНИЙ ---------- */
app.get("/messages", async (req, res) => {
  const messagesResp = await supabase
    .from("messages")
    .select("*")
    .order("id", { ascending: true });
  const messages = messagesResp.data;
  res.json(messages);
});

/* ---------- SOCKET.IO ---------- */
io.on("connection", (socket) => {
  let nick = "";

  socket.on("set nick", (n) => {
    nick = n;
  });

  socket.on("private message", async (data) => {
    const { fromNick, toNick, msg } = data;

    await supabase.from("messages").insert([
      { from: fromNick, to: toNick, text: msg }
    ]);

    io.emit("private message", data);
  });

  socket.on("disconnect", () => {});
});

/* ---------- ЗАПУСК СЕРВЕРА ---------- */
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});