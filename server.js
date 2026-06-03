const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

const DB_FILE = "db.json";

/* ===== MEMORY ===== */
let history = [];

function loadHistory(){
    try {
        if (fs.existsSync(DB_FILE)) {
            history = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
        }
    } catch {
        history = [];
    }
}

function saveHistory(){
    fs.writeFileSync(DB_FILE, JSON.stringify(history, null, 2));
}

loadHistory();

/* ===== CLIENTS ===== */
let clients = new Set();

/* ===== BROADCAST ===== */
function broadcast(data){
    const str = JSON.stringify(data);

    for (const c of clients) {
        if (c.readyState === 1) {
            c.send(str);
        }
    }
}

wss.on("connection", (ws) => {

    clients.add(ws);

    // 🔥 отправляем старые сообщения
    history.forEach(m => {
        ws.send(JSON.stringify({ type: "msg", text: m }));
    });

    ws.on("message", (raw) => {

        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }

        if (msg.type === "nick") {
            ws.nick = msg.nick;
            broadcast({
                type: "system",
                text: `🟢 ${ws.nick} вошёл`
            });
            return;
        }

        if (msg.type === "chat") {

            const text = `${ws.nick || "Anon"}: ${msg.text}`;

            history.push(text);
            saveHistory();

            broadcast({
                type: "msg",
                text
            });

            return;
        }
    });

    ws.on("close", () => {
        clients.delete(ws);

        if (ws.nick) {
            broadcast({
                type: "system",
                text: `🔴 ${ws.nick} вышел`
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running"));
