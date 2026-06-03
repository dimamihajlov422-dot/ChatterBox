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

try {
    if (fs.existsSync(DB_FILE)) {
        history = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    }
} catch {
    history = [];
}

function save(){
    fs.writeFileSync(DB_FILE, JSON.stringify(history, null, 2));
}

/* ===== CLIENTS ===== */
let clients = new Map();

function broadcast(obj){
    const data = JSON.stringify(obj);

    for(const c of wss.clients){
        if(c.readyState === 1){
            c.send(data);
        }
    }
}

wss.on("connection", (ws) => {

    // отправляем историю
    ws.send(JSON.stringify({
        type:"history",
        data: history
    }));

    ws.on("message", (raw) => {

        let msg;
        try { msg = JSON.parse(raw.toString()); }
        catch { return; }

        /* NICK */
        if(msg.type === "nick"){
            ws.nick = msg.nick || "Anon";

            broadcast({
                type:"system",
                text:`🟢 ${ws.nick} вошёл`
            });

            return;
        }

        /* CHAT */
        if(msg.type === "chat"){

            const m = {
                text:`${ws.nick || "Anon"}: ${msg.text}`
            };

            history.push(m);
            save();

            broadcast({
                type:"msg",
                data:m
            });

            return;
        }

        /* CALL SIGNAL (WebRTC) */
        if(msg.type === "call-signal"){
            for(const c of wss.clients){
                if(c !== ws && c.readyState === 1){
                    c.send(JSON.stringify({
                        type:"call-signal",
                        data: msg.data
                    }));
                }
            }
        }

        if(msg.type === "call-start"){
            broadcast({
                type:"system",
                text:`📞 ${ws.nick || "Anon"} начал звонок`
            });
        }

        if(msg.type === "call-end"){
            broadcast({
                type:"system",
                text:`📴 ${ws.nick || "Anon"} завершил звонок`
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running"));
