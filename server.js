const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const bodyParser = require("body-parser");

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.use(bodyParser.json());

// Хранилища
const users = {};         // { nick: password }
const onlineUsers = {};   // { socket.id: nick }
const privateRooms = {};  // { "nick1_nick2": [{nick,msg}, ...] }
const generalChat = [];

// Регистрация
app.post("/register", (req, res) => {
    const { nick, password } = req.body;
    if (!nick || !password) return res.status(400).send({ error: "Заполните поля" });
    if (users[nick]) return res.status(400).send({ error: "Ник занят" });
    users[nick] = password;
    return res.send({ success: true });
});

// Вход
app.post("/login", (req, res) => {
    const { nick, password } = req.body;
    if (!nick || !password) return res.status(400).send({ error: "Заполните поля" });
    if (users[nick] !== password) return res.status(400).send({ error: "Неверный ник или пароль" });
    return res.send({ success: true });
});

// Socket.io
io.on("connection", socket => {

    socket.on("set nick", nick => {
        onlineUsers[socket.id] = nick;
        io.emit("update users", Object.values(onlineUsers));
        socket.emit("general chat", generalChat);
    });

    socket.on("private message", data => {
        const roomId = [data.fromNick, data.toNick].sort().join("_");
        if (!privateRooms[roomId]) privateRooms[roomId] = [];
        privateRooms[roomId].push({ nick: data.fromNick, msg: data.msg });

        const toSocketId = Object.keys(onlineUsers).find(id => onlineUsers[id] === data.toNick);

        socket.emit("private message", { fromNick: data.fromNick, msg: data.msg, toNick: data.toNick });
        if (toSocketId) io.to(toSocketId).emit("private message", { fromNick: data.fromNick, msg: data.msg, toNick: data.toNick });
    });

    socket.on("disconnect", () => {
        delete onlineUsers[socket.id];
        io.emit("update users", Object.values(onlineUsers));
    });

});

http.listen(PORT, () => console.log("Сервер запущен на порту " + PORT));