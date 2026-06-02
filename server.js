const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* =========================
   STATIC FILES (ВАЖНО)
========================= */
app.use(express.static(path.join(__dirname, "public")));

/* =========================
   DB FILE
========================= */
const DB_FILE = path.join(__dirname, "db.json");

/* =========================
   LOAD HISTORY SAFE
========================= */
let history = [];

try {
    if (fs.existsSync(DB_FILE)) {
        const data = fs.readFileSync(DB_FILE, "utf8");
        const parsed = JSON.parse(data);
        history = Array.isArray(parsed) ? parsed : [];
    }
} catch (e) {
    console.log("DB load error → reset history");
    history = [];
}

/* =========================
   USERS
========================= */
let clients = new Map();

/* =========================
   TIME (MOSCOW FIX)
========================= */
function now() {
    return new Date().toLocaleTimeString("ru-RU", {
        timeZone: "Europe/Moscow",
        hour: "2-digit",
        minute: "2-digit"
    });
}

/* =========================
   SAVE MESSAGE
========================= */
function save(message) {
    history.push(message);

    if (history.length > 200) {
        history.shift();
    }

    fs.writeFileSync(DB_FILE, JSON.stringify(history, null, 2));
}

/* =========================
   BROADCAST
========================= */
function broadcast(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

/* =========================
   WS CONNECTION
========================= */
wss.on("connection", (ws) => {
    console.log("Client connected");

    // send history
    history.forEach(msg => {
        ws.send(msg);
    });

    ws.on("message", (data) => {
        let msg;

        try {
            msg = JSON.parse(data.toString());
        } catch {
            return;
        }

        /* ===== NICK ===== */
        if (msg.type === "nick") {
            clients.set(ws, msg.nick);

            const message = `[${now()}] 🟢 ${msg.nick} вошёл в чат`;

            save(message);
            broadcast(message);
            return;
        }

        /* ===== CHAT ===== */
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

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
