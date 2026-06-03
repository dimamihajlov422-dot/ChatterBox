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

let history = [];

try {
    if (fs.existsSync(DB_FILE)) {
        const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
        history = Array.isArray(data) ? data : [];
    }
} catch {
    history = [];
}

let clients = new Map();

function save(){
    fs.writeFileSync(DB_FILE, JSON.stringify(history, null, 2));
}

function now(){
    return new Date().toLocaleTimeString("ru-RU", {
        timeZone:"Europe/Moscow",
        hour:"2-digit",
        minute:"2-digit"
    });
}

function broadcast(obj){
    const data = JSON.stringify(obj);

    for(const c of wss.clients){
        if(c.readyState === WebSocket.OPEN){
            c.send(data);
        }
    }
}

wss.on("connection",(ws)=>{

    ws.ready = false;
    ws.queue = [];

    ws.on("message",(raw)=>{

        let msg;
        try{ msg = JSON.parse(raw); }
        catch{return;}

        // NICK
        if(msg.type === "nick"){

            for(const u of clients.values()){
                if(u.nick === msg.nick){
                    ws.send(JSON.stringify({
                        type:"error",
                        text:"Ник уже занят"
                    }));
                    return;
                }
            }

            clients.set(ws,{nick:msg.nick});

            ws.ready = true;

            // отправка истории
            for(const m of history){
                ws.send(JSON.stringify({type:"msg", data:m}));
            }

            // отправка очереди (если были сообщения до подключения)
            ws.queue.forEach(q => ws.send(JSON.stringify(q)));
            ws.queue = [];

            broadcast({
                type:"msg",
                data:{
                    id:Date.now().toString(),
                    text:`[${now()}] 🟢 ${msg.nick} вошёл`
                }
            });

            return;
        }

        const user = clients.get(ws);
        const nick = user ? user.nick : "Anon";

        // CHAT
        if(msg.type === "chat"){

            const m = {
                id:Date.now().toString(),
                text:`[${now()}] ${nick}: ${msg.text}`
            };

            history.push(m);
            save();

            broadcast({type:"msg", data:m});
            return;
        }

        // DM
        if(msg.type === "dm"){

            const payload = {
                type:"dm",
                from:nick,
                to:msg.to,
                text:msg.text
            };

            for(const [sock,u] of clients){
                if(u.nick === msg.to){
                    sock.send(JSON.stringify(payload));
                }
            }

            ws.send(JSON.stringify(payload));
        }
    });

    ws.on("close",()=>{
        const u = clients.get(ws);
        clients.delete(ws);

        if(u){
            broadcast({
                type:"msg",
                data:{
                    id:Date.now().toString(),
                    text:`[${now()}] 🔴 ${u.nick} вышел`
                }
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log("Server running"));
