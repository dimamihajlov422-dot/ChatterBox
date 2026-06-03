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

let db = { messages: [] };

try {
    if (fs.existsSync(DB_FILE)) {
        db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    }
} catch {}

let clients = new Map();

/* ROOM ID (как в Telegram диалог) */
function roomId(a,b){
    return [a,b].sort().join("_");
}

function save(){
    fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2));
}

function now(){
    return new Date().toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"});
}

function sendToRoom(room, obj){
    const data = JSON.stringify(obj);

    for(const [ws,u] of clients){
        if(u.room === room && ws.readyState === 1){
            ws.send(data);
        }
    }
}

wss.on("connection",(ws)=>{

    ws.on("message",(raw)=>{

        let msg;
        try{ msg = JSON.parse(raw); }
        catch{return;}

        /* LOGIN */
        if(msg.type==="nick"){
            clients.set(ws,{
                nick:msg.nick,
                room:"global"
            });

            sendToRoom("global",{
                type:"system",
                text:`🟢 ${msg.nick} вошёл`
            });

            return;
        }

        const user = clients.get(ws);
        if(!user) return;

        /* SWITCH ROOM */
        if(msg.type==="room"){
            user.room = msg.room;
            return;
        }

        /* CHAT */
        if(msg.type==="chat"){

            const m = {
                id:Date.now().toString(),
                room:user.room,
                text:`[${now()}] ${user.nick}: ${msg.text}`
            };

            db.messages.push(m);
            save();

            sendToRoom(user.room,{
                type:"msg",
                data:m
            });

            return;
        }

        /* DM (как Telegram чат 1-1) */
        if(msg.type==="dm"){

            const room = roomId(user.nick,msg.to);

            const m = {
                id:Date.now().toString(),
                room,
                text:`[${now()}] ${user.nick}: ${msg.text}`
            };

            db.messages.push(m);
            save();

            sendToRoom(room,{
                type:"msg",
                data:m
            });

            return;
        }
    });

    ws.on("close",()=>{
        const u = clients.get(ws);
        if(u){
            sendToRoom("global",{
                type:"system",
                text:`🔴 ${u.nick} вышел`
            });
        }
        clients.delete(ws);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log("Server running"));
