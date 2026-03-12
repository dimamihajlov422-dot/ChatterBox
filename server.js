const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// Папка с фронтендом
app.use(express.static('public'));

// Когда кто-то подключается
io.on('connection', (socket) => {
  console.log('Новый друг подключился');

  // Слушаем сообщения
  socket.on('chat message', (msg) => {
    io.emit('chat message', msg); // отправляем всем
  });
});

// Запуск сервера на порту 3000
http.listen(3000, () => {
  console.log('Сервер запущен на http://localhost:3000');
});