// server.js — полностью рабочий вариант для ChatterBox

const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

const PORT = process.env.PORT || 3000;

// Отдаём все файлы из папки public
app.use(express.static('public'));

// Когда подключается новый пользователь
io.on('connection', (socket) => {
    console.log('Новый пользователь подключился');

    // Получаем объект с ником и сообщением
    socket.on('chat message', (data) => {
        io.emit('chat message', data); // Отправляем всем
    });

    socket.on('disconnect', () => {
        console.log('Пользователь отключился');
    });
});

// Запуск сервера
http.listen(PORT, () => {
    console.log(Сервер запущен на порту ${PORT});
});
