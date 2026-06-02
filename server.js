const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

let clients = new Map(); // ws -> nickname

wss.on("connection", (ws) => {
    console.log("Client connected");

    ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());

        // установка ника
        if (msg.type === "nick") {
            clients.set(ws, msg.nick);
            broadcast(`🟢 ${msg.nick} вошёл в чат`);
            return;
        }

        // обычное сообщение
        if (msg.type === "chat") {
            const nick = clients.get(ws) || "Anon";
            broadcast(`${nick}: ${msg.text}`);
        }
    });

    ws.on("close", () => {
        const nick = clients.get(ws);
        clients.delete(ws);
        if (nick) broadcast(`🔴 ${nick} вышел`);
    });
});

function broadcast(message) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
