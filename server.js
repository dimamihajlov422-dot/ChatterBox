// server.js — полностью рабочий вариант для ChatterBox

const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

const PORT = process.env.PORT || 3000;

// Отдаём все файлы из папки public
app.use(express.static('public'));

// Когда подключается новый пользователь
et messages = [ ] ;
io.on('connection', (socket) => {
    console.log('Новый пользователь подключился');
messages.forEach((msg) => {
    socket.emit('chat message', msg);
});
    // Получаем объект с ником и сообщением
    socket.on('chat message', (data) => {
    messages.push(data); // сохраняем сообщение
    io.emit('chat message', data); // отправляем всем
});

    socket.on('disconnect', () => {
        console.log('Пользователь отключился');
    });
});

// Запуск сервера
http.listen(PORT, () => {
    console.log(Сервер запущен на порту ${PORT});
});
