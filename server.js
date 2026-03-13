const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

let messages = [];

io.on("connection", (socket) => {
    console.log("Пользователь подключился");

    messages.forEach((msg) => {
        socket.emit("chat message", msg);
    });

    socket.on("chat message", (data) => {
        messages.push(data);
        io.emit("chat message", data);
    });

    socket.on("disconnect", () => {
        console.log("Пользователь отключился");
    });
});

http.listen(PORT, () => {
    console.log("Сервер запущен на порту " + PORT);
});
