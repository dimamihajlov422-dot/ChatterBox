const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

// Хранилище сообщений по комнатам
const rooms = {
    "Общий": [],
    "Тест": [],
    "Игры": []
};

io.on("connection", (socket) => {
    console.log("Пользователь подключился");

    // Подключение к комнате
    socket.on("join room", (room) => {
        socket.join(room);
        console.log(Пользователь подключился к комнате: ${room});

        // Отправляем историю сообщений этой комнаты
        if (rooms[room]) {
            rooms[room].forEach(msg => {
                socket.emit("chat message", { room, ...msg });
            });
        }
    });

    // Получение нового сообщения
    socket.on("chat message", (data) => {
        if (rooms[data.room]) {
            rooms[data.room].push({ nick: data.nick, msg: data.msg });
            io.to(data.room).emit("chat message", data);
        }
    });

    socket.on("disconnect", () => {
        console.log("Пользователь отключился");
    });
});

http.listen(PORT, () => {
    console.log(Сервер запущен на порту ${PORT});
});