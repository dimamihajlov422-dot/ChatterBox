const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

let history = [];
let users = new Map();
let rate = new Map();

/* ===== LOAD ===== */
try {
    if (fs.existsSync("db.json")) {
        history = JSON.parse(fs.readFileSync("db.json", "utf8")) || [];
    }
} catch {
    history = [];
}

/* ===== SAVE ===== */
function save(){
    fs.writeFileSync("db.json", JSON.stringify(history.slice(-200), null, 2));
}

/* ===== BROADCAST ===== */
function broadcast(obj){
    const data = JSON.stringify(obj);

    for(const c of wss.clients){
        if(c.readyState === 1){
            c.send(data);
        }
    }
}

/* ===== RATE LIMIT ===== */
function checkRate(ws){
    const now = Date.now();
    if(!rate.has(ws)) rate.set(ws, []);

    const arr = rate.get(ws).filter(t => now - t < 1000);
    arr.push(now);

    rate.set(ws, arr);
    return arr.length <= 5;
}

/* ===== NICK VALIDATION ===== */
function validNick(nick){
    if(typeof nick !== "string") return false;

    nick = nick.trim();

    if(nick.length < 2 || nick.length > 16) return false;
    if(!/^[a-zA-Zа-яА-Я0-9_]+$/.test(nick)) return false;

    return true;
}

function nickExists(nick){
    for(const u of users.values()){
        if(u === nick) return true;
    }
    return false;
}

/* ===== XSS SAFE ===== */
function escapeHtml(str){
    return String(str)
        .replace(/&/g,"&amp;")
        .replace(/</g,"&lt;")
        .replace(/>/g,"&gt;");
}

/* ===== WS ===== */
wss.on("connection", (ws) => {

    ws.on("message", (raw) => {

        let msg;
        try { msg = JSON.parse(raw); }
        catch { return; }

        /* LOGIN */
        if(msg.type === "login"){

            if(!validNick(msg.nick)){
                ws.send(JSON.stringify({
                    type:"error",
                    text:"Некорректный ник (2–16, буквы/цифры/_ )"
                }));
                return;
            }

            const nick = msg.nick.trim();

            if(nickExists(nick)){
                ws.send(JSON.stringify({
                    type:"error",
                    text:"Ник занят"
                }));
                return;
            }

            ws.nick = nick;
            users.set(ws, nick);

            broadcast({
                type:"users",
                users: Array.from(users.values())
            });

            broadcast({
                type:"system",
                text:`🟢 ${nick} вошёл`
            });

            return;
        }

        if(!ws.nick) return;

        /* CHAT */
        if(msg.type === "chat"){

            if(!checkRate(ws)) return;

            const text = escapeHtml((msg.text || "").slice(0,300));

            const m = {
                text:`${ws.nick}: ${text}`
            };

            history.push(m);
            history = history.slice(-200);
            save();

            broadcast({ type:"msg", data:m });
            return;
        }

        /* VOICE */
        if(msg.type === "voice"){
            if(!Array.isArray(msg.data)) return;

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

        users.delete(ws);

        if(ws.nick){
            broadcast({
                type:"system",
                text:`🔴 ${ws.nick} вышел`
            });
        }
    });
});

server.listen(3000, () => console.log("v15.1 SAFE running"));
