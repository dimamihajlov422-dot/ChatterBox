const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

let clients = new Set();

function broadcast(obj){
    const data = JSON.stringify(obj);

    for(const c of clients){
        if(c.readyState === 1){
            c.send(data);
        }
    }
}

wss.on("connection", (ws) => {

    clients.add(ws);

    ws.on("message", (raw) => {

        let msg;
        try { msg = JSON.parse(raw.toString()); }
        catch { return; }

        // NICK
        if(msg.type === "nick"){
            ws.nick = msg.nick || "Anon";

            broadcast({
                type:"system",
                text:`🟢 ${ws.nick} вошёл`
            });

            return;
        }

        // CHAT
        if(msg.type === "chat"){
            broadcast({
                type:"msg",
                text:`${ws.nick || "Anon"}: ${msg.text}`
            });
            return;
        }

        // CALL START
        if(msg.type === "call-start"){
            broadcast({
                type:"system",
                text:`📞 ${ws.nick || "Anon"} начал звонок`
            });
            return;
        }

        // CALL END
        if(msg.type === "call-end"){
            broadcast({
                type:"system",
                text:`📴 ${ws.nick || "Anon"} завершил звонок`
            });
            return;
        }

    });

    ws.on("close", () => {
        clients.delete(ws);

        if(ws.nick){
            broadcast({
                type:"system",
                text:`🔴 ${ws.nick} вышел`
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running"));
