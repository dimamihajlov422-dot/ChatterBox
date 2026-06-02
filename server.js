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
        const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
        history = Array.isArray(data) ? data : [];
    } catch {
        history = [];
    }
}

let clients = new Map(); // ws -> nick

function now() {
    return new Date().toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit"
    });
}

function save(msg) {
    history.push(msg);
    if (history.length > 100) history.shift();
    fs.writeFileSync(DB_FILE, JSON.stringify(history, null, 2));
}

function broadcast(msg) {
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({ type: "public", text: msg }));
        }
    });
}

function sendToNick(nick, data) {
    for (let [ws, name] of clients.entries()) {
        if (name === nick && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
            return ws;
        }
    }
    return null;
}

wss.on("connection", (ws) => {

    // отправка истории
    history.forEach(m => {
        ws.send(JSON.stringify({ type: "public", text: m }));
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
            broadcast(`[${now()}] 🟢 ${msg.nick} вошёл`);
            return;
        }

        // ---------- CHAT ----------
        if (msg.type === "chat") {
            const nick = clients.get(ws) || "Anon";

            const time = now();

            // PRIVATE MESSAGE
            if (msg.to) {
                const text = `[ЛС ${time}] ${nick}: ${msg.text}`;

                ws.send(JSON.stringify({
                    type: "private",
                    from: nick,
                    text
                }));

                const target = sendToNick(msg.to, {
                    type: "private",
                    from: nick,
                    text: text
                });

                if (target) {
                    target.send(JSON.stringify({
                        type: "notify",
                        text: `🔔 ЛС от ${nick}`
                    }));
                }

                return;
            }

            // PUBLIC
            const message = `[${time}] ${nick}: ${msg.text}`;

            save(message);
            broadcast(message);
        }
    });

    ws.on("close", () => {
        const nick = clients.get(ws);
        clients.delete(ws);

        if (nick) {
            broadcast(`[${now()}] 🔴 ${nick} вышел`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running"));
