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

/* ===== CALL STATE ===== */
let callUsers = new Set();

function broadcast(obj){
    const data = JSON.stringify(obj);

    for(const c of wss.clients){
        if(c.readyState === 1){
            c.send(data);
        }
    }
}

function updateCallState(){
    broadcast({
        type:"call-state",
        active: callUsers.size > 0
    });
}

wss.on("connection", (ws) => {

    ws.id = Math.random().toString(36).slice(2);

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
            ws.nick = msg.nick;
            broadcast({ type:"system", text:`🟢 ${ws.nick} вошёл` });
            return;
        }

        /* CHAT */
        if(msg.type === "chat"){
            const m = {
                text:`${ws.nick || "Anon"}: ${msg.text}`
            };

            history.push(m);
            save();

            broadcast({ type:"msg", data:m });
            return;
        }

        /* CALL START */
        if(msg.type === "call-start"){
            callUsers.add(ws.id);
            updateCallState();

            broadcast({
                type:"system",
                text:`📞 ${ws.nick} в звонке`
            });

            return;
        }

        /* CALL END */
        if(msg.type === "call-end"){
            callUsers.delete(ws.id);
            updateCallState();

            broadcast({
                type:"system",
                text:`📴 ${ws.nick} вышел из звонка`
            });

            return;
        }

        /* VOICE */
        if(msg.type === "voice"){
            for(const c of wss.clients){
                if(c !== ws && c.readyState === 1){
                    c.send(JSON.stringify({
                        type:"voice",
                        data: msg.data
                    }));
                }
            }
        }
    });

    ws.on("close", () => {
        callUsers.delete(ws.id);
        updateCallState();

        if(ws.nick){
            broadcast({ type:"system", text:`🔴 ${ws.nick} вышел` });
        }
    });
});

server.listen(3000, () => console.log("Server running"));
