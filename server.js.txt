const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

// Онлайн-пользователи: { socket.id: nick }
const onlineUsers = {};

// Приватные комнаты: { roomId: [{nick,msg}, ...] }
const privateRooms = {};

// Общий чат (только читать)
const generalChat = [];

io.on("connection", socket => {
    // Получаем ник
    socket.on("set nick", nick => {
        onlineUsers[socket.id] = nick;

        // Обновляем список контактов у всех
        io.emit("update users", Object.values(onlineUsers));

        // Отправляем историю общего чата
        socket.emit("general chat", generalChat);
    });

    // Приватные сообщения
    socket.on("private message", data => {
        // data: { toNick, msg, fromNick }
        const roomId = [data.fromNick, data.toNick].sort().join("_");
        if (!privateRooms[roomId]) privateRooms[roomId] = [];
        privateRooms[roomId].push({ nick: data.fromNick, msg: data.msg });

        // Найти socket.id получателя
        const toSocketId = Object.keys(onlineUsers).find(id => onlineUsers[id] === data.toNick);

        // Отправить обоим
        socket.emit("private message", { fromNick: data.fromNick, msg: data.msg, toNick: data.toNick });
        if (toSocketId) io.to(toSocketId).emit("private message", { fromNick: data.fromNick, msg: data.msg, toNick: data.toNick });
    });

    socket.on("disconnect", () => {
        delete onlineUsers[socket.id];
        io.emit("update users", Object.values(onlineUsers));
    });
});

http.listen(PORT, () => console.log("Сервер запущен на порту " + PORT));