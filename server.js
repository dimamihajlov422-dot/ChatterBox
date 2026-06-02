const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

const DB_FILE = "db.json";

// ---------- LOAD ----------
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

// ---------- TIME (FIXED) ----------
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
function broadcast(obj) {
    const data = JSON.stringify(obj);

    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
            c.send(data);
        }
    });
}

// ---------- WS ----------
wss.on("connection", (ws) => {

    // history
    history.forEach(m => {
        ws.send(JSON.stringify({ type: "msg", text: m }));
    });

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

            const text = `[${now()}] 🟢 ${msg.nick} вошёл`;

            save(text);
            broadcast({ type: "msg", text });
            return;
        }

        // ---------- CHAT ----------
        if (msg.type === "chat") {
            const nick = clients.get(ws) || "Anon";

            const text = `[${now()}] ${nick}: ${msg.text}`;

            save(text);
            broadcast({ type: "msg", text });
        }
    });

    ws.on("close", () => {
        const nick = clients.get(ws);
        clients.delete(ws);

        if (nick) {
            const text = `[${now()}] 🔴 ${nick} вышел`;

            save(text);
            broadcast({ type: "msg", text });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running"));
