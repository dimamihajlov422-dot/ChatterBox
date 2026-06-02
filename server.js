const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

const DB_FILE = path.join(__dirname, "db.json");

/* ======================
   LOAD HISTORY
====================== */
let history = [];

try {
    if (fs.existsSync(DB_FILE)) {
        const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
        history = Array.isArray(data) ? data : [];
    }
} catch {
    history = [];
}

/* ======================
   USERS
====================== */
let clients = new Map(); // ws -> nick

/* ======================
   TIME (MOSCOW FIX)
====================== */
function now() {
    return new Date().toLocaleTimeString("ru-RU", {
        timeZone: "Europe/Moscow",
        hour: "2-digit",
        minute: "2-digit"
    });
}

/* ======================
   SAVE
====================== */
function save() {
    fs.writeFileSync(DB_FILE, JSON.stringify(history, null, 2));
}

/* ======================
   BROADCAST
====================== */
function broadcast(obj) {
    const data = JSON.stringify(obj);

    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
            c.send(data);
        }
    });
}

/* ======================
   WS
====================== */
wss.on("connection", (ws) => {

    // send history
    history.forEach(m => ws.send(JSON.stringify({
        type: "msg",
        data: m
    })));

    ws.on("message", (raw) => {
        let msg;

        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }

        /* ======================
           NICK (NO DUPLICATES)
        ====================== */
        if (msg.type === "nick") {

            for (let name of clients.values()) {
                if (name === msg.nick) {
                    ws.send(JSON.stringify({
                        type: "error",
                        text: "❌ Ник уже занят"
                    }));
                    return;
                }
            }

            clients.set(ws, msg.nick);

            const m = {
                id: Date.now().toString(),
                text: `[${now()}] 🟢 ${msg.nick} вошёл`,
                pinned: false
            };

            history.push(m);
            save();

            broadcast({ type: "msg", data: m });
            return;
        }

        /* ======================
           CHAT
        ====================== */
        if (msg.type === "chat") {

            const nick = clients.get(ws) || "Anon";

            const m = {
                id: Date.now().toString() + Math.random(),
                text: `[${now()}] ${nick}: ${msg.text}`,
                pinned: false
            };

            history.push(m);
            save();

            broadcast({ type: "msg", data: m });
        }

        /* ======================
           PIN
        ====================== */
        if (msg.type === "pin") {
            const item = history.find(m => m.id === msg.id);
            if (item) {
                item.pinned = true;
                save();

                broadcast({ type: "pin", id: msg.id });
            }
        }
    });

    ws.on("close", () => {
        const nick = clients.get(ws);
        clients.delete(ws);

        if (nick) {
            const m = {
                id: Date.now().toString(),
                text: `[${now()}] 🔴 ${nick} вышел`,
                pinned: false
            };

            history.push(m);
            save();

            broadcast({ type: "msg", data: m });
        }
    });
});

/* ======================
   START
====================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running"));
