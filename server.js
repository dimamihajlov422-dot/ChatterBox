const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

const DB_FILE = "db.json";

// ---------- LOAD HISTORY ----------
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

// ---------- TIME FIX ----------
function now() {
    return new Date().toLocaleTimeString("ru-RU", {
        timeZone: "Europe/Moscow",
        hour: "2-digit",
        minute: "2-digit"
    });
}

// ---------- SAVE ----------
function save(msg) {
    history.push(msg);
    if (history.length > 200) history.shift();

    fs.writeFileSync(DB_FILE, JSON.stringify(history, null, 2));
}

// ---------- BROADCAST ----------
function broadcast(msg) {
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
            c.send(msg);
        }
    });
}

// ---------- WS ----------
wss.on("connection", (ws) => {

    // история
    history.forEach(m => ws.send(m));

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

            const message = `[${now()}] 🟢 ${msg.nick} вошёл`;

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
server.listen(PORT, () => console.log("Server running"));
