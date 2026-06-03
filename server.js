const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

let history = [];
let users = new Map();   // ws -> nick
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

/* ===== SAFE ===== */
function escapeHtml(str){
    return String(str)
        .replace(/&/g,"&amp;")
        .replace(/</g,"&lt;")
        .replace(/>/g,"&gt;");
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

/* ===== USERS BROADCAST ===== */
function sendUsers(){
    const list = Array.from(users.values());

    broadcast({
        type:"users",
        users: list
    });
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

/* ===== VALIDATION ===== */
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

/* ===== WS ===== */
wss.on("connection", (ws) => {

    ws.isAlive = true;

    ws.on("pong", ()=> ws.isAlive = true);

    ws.send(JSON.stringify({
        type:"history",
        data: history.slice(-200)
    }));

    ws.send(JSON.stringify({
        type:"users",
        users: Array.from(users.values())
    }));

    ws.on("message", (raw) => {

        let msg;
        try { msg = JSON.parse(raw); }
        catch { return; }

        /* LOGIN */
        if(msg.type === "login"){

            if(!validNick(msg.nick)){
                ws.send(JSON.stringify({
                    type:"error",
                    text:"Ник 2–16 символов (буквы/цифры/_)"
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

            sendUsers();

            broadcast({
                type:"system",
                text:`🟢 ${escapeHtml(nick)} вошёл`
            });

            return;
        }

        if(!ws.nick){
            ws.send(JSON.stringify({
                type:"error",
                text:"Сначала логин"
            }));
            return;
        }

        /* CHAT */
        if(msg.type === "chat"){

            if(!checkRate(ws)) return;

            const m = {
                id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
                text: escapeHtml(ws.nick) + ": " + escapeHtml((msg.text || "").slice(0, 300)),
                owner: ws.nick
            };

            history.push(m);
            history = history.slice(-200);
            save();

            broadcast({ type:"msg", data:m });
            return;
        }

        /* DELETE (SAFE OWNER CHECK) */
        if(msg.type === "delete"){

            const m = history.find(x => x.id === msg.id);

            if(!m) return;
            if(m.owner !== ws.nick) return;

            history = history.filter(x => x.id !== msg.id);
            save();

            broadcast({
                type:"delete",
                id: msg.id
            });

            return;
        }

        /* CALL */
        if(msg.type === "call-start"){
            broadcast({ type:"system", text:`📞 ${escapeHtml(ws.nick)} в звонке` });
        }

        if(msg.type === "call-end"){
            broadcast({ type:"system", text:`📴 ${escapeHtml(ws.nick)} вышел из звонка` });
        }
    });

    ws.on("close", () => {

        if(ws.nick){
            users.delete(ws);
            rate.delete(ws);

            sendUsers();

            broadcast({
                type:"system",
                text:`🔴 ${escapeHtml(ws.nick)} вышел`
            });
        }
    });
});

/* ===== PING PONG ===== */
setInterval(() => {
    wss.clients.forEach(ws => {
        if(!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

server.listen(3000, () => console.log("v18 FINAL running"));
