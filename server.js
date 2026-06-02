const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

const DB_FILE = "db.json";

let history = [];

if (fs.existsSync(DB_FILE)) {
    try {
        history = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    } catch {
        history = [];
    }
}

let clients = new Map();

wss.on("connection", (ws) => {
    console.log("Client connected");

    // Отправляем историю новому пользователю
    history.forEach(msg => {
        ws.send(msg);
    });

    ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === "nick") {
            clients.set(ws, msg.nick);

            const time = new Date().toLocaleTimeString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit"
            });

            broadcast(`[${time}] 🟢 ${msg.nick} вошёл в чат`);
            return;
        }

        if (msg.type === "chat") {
            const nick = clients.get(ws) || "Anon";

            const time = new Date().toLocaleTimeString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit"
            });

            const message = `[${time}] ${nick}: ${msg.text}`;

            history.push(message);

            if (history.length > 100) {
                history.shift();
            }

            fs.writeFileSync(
                DB_FILE,
                JSON.stringify(history, null, 2)
            );

            broadcast(message);
        }
    });

    ws.on("close", () => {
        const nick = clients.get(ws);

        clients.delete(ws);

        if (nick) {
            const time = new Date().toLocaleTimeString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit"
            });

            broadcast(`[${time}] 🔴 ${nick} вышел`);
        }
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
