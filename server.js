const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

let clients = new Set();

wss.on("connection", (ws) => {

    clients.add(ws);

    ws.on("message", (raw) => {
        let msg;

        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }

        // ник
        if (msg.type === "nick") {
            ws.nick = msg.nick || "Anon";

            broadcast({
                type: "system",
                text: `🟢 ${ws.nick} вошёл`
            });

            return;
        }

        // чат
        if (msg.type === "chat") {
            const text = msg.text || "";

            broadcast({
                type: "msg",
                text: `${ws.nick || "Anon"}: ${text}`
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

function broadcast(data) {
    const str = JSON.stringify(data);

    for (const c of clients) {
        if (c.readyState === 1) {
            c.send(str);
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running"));
