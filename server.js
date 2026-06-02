const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

const DB_FILE = "db.json";

// ---------- SAFE HISTORY ----------
let history = [];

if (fs.existsSync(DB_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
        history = Array.isArray(data) ? data : [];
    } catch {
        history = [];
    }
}

let clients = new Map();

function now() {
    return new Date().toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit"
    });
}

function save(message) {
    history.push(message);
    if (history.length > 100) history.shift();
    fs.writeFileSync(DB_FILE, JSON.stringify(history, null, 2));
}

function broadcast(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

wss.on("connection", (ws) => {
    console.log("Client connected");

    // история
    history.forEach(msg => ws.send(msg));

    ws.on("message", (data) => {
        let msg;

        try {
            msg = JSON.parse(data.toString());
        } catch {
            return;
        }

        // ---------- NICK ----------
        if (msg.type === "nick") {
            clients.set(ws, msg.nick);

            const message = `[${now()}] 🟢 ${msg.nick} вошёл в чат`;

            save(message);
            broadcast(message);
            return;
        }

        // ---------- CHAT ----------
        if (msg.type === "chat") {
            const nick = clients.get(ws) || "Anon";

            const message = `[${now()}] ${nick}: ${msg.text}`;

            save(message);
            broadcast(message);
        }
    });

    ws.on("close", () => {
        const nick = clients.get(ws);
        clients.delete(ws);

        if (nick) {
            const message = `[${now()}] 🔴 ${nick} вышел`;

            save(message);
            broadcast(message);
        }
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
