const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

let history = [];
let privateHistory = {};
let users = new Map();
let rate = new Map();

/* ===== ЗАГРУЗКА ИСТОРИИ ===== */
try {
    if (fs.existsSync("db.json")) {
        history = JSON.parse(fs.readFileSync("db.json", "utf8")) || [];
    }
} catch {
    history = [];
}

try {
    if (fs.existsSync("private.json")) {
        privateHistory = JSON.parse(fs.readFileSync("private.json", "utf8")) || {};
    }
} catch {
    privateHistory = {};
}

/* ===== СОХРАНЕНИЕ ===== */
function savePublic() {
    fs.writeFileSync("db.json", JSON.stringify(history.slice(-200), null, 2));
}

function savePrivate() {
    fs.writeFileSync("private.json", JSON.stringify(privateHistory, null, 2));
}

/* ===== ЗАЩИТА ===== */
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/* ===== ЗАЩИТА ОТ СПАМА ===== */
function checkRate(ws) {
    const now = Date.now();
    if (!rate.has(ws)) rate.set(ws, []);
    const arr = rate.get(ws).filter(t => now - t < 1000);
    arr.push(now);
    rate.set(ws, arr);
    return arr.length <= 5;
}

/* ===== РАССЫЛКА ===== */
function broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const c of wss.clients) {
        if (c.readyState === 1) {
            c.send(data);
        }
    }
}

function sendUsers() {
    broadcast({
        type: "users",
        users: Array.from(users.values())
    });
}

/* ===== ВАЛИДАЦИЯ НИКА ===== */
function validNick(nick) {
    if (typeof nick !== "string") return false;
    nick = nick.trim();
    if (nick.length < 2 || nick.length > 16) return false;
    if (!/^[a-zA-Zа-яА-Я0-9_]+$/.test(nick)) return false;
    return true;
}

function nickExists(nick) {
    for (const u of users.values()) {
        if (u === nick) return true;
    }
    return false;
}

/* ===== КЛЮЧ ДЛЯ ЛИЧНЫХ СООБЩЕНИЙ ===== */
function getPrivateKey(user1, user2) {
    return [user1, user2].sort().join("_");
}

/* ===== ВЕБСОКЕТ ===== */
wss.on("connection", (ws) => {
    ws.isAlive = true;

    ws.on("pong", () => {
        ws.isAlive = true;
    });

    // Отправляем историю и список пользователей при подключении
    ws.send(JSON.stringify({
        type: "history",
        data: history.slice(-200)
    }));

    ws.send(JSON.stringify({
        type: "users",
        users: Array.from(users.values())
    }));

    ws.on("message", (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }

        /* ===== ЛОГИН ===== */
        if (msg.type === "login") {
            if (!validNick(msg.nick)) {
                ws.send(JSON.stringify({
                    type: "error",
                    text: "Ник 2-16 символов (буквы/цифры/_)"
                }));
                return;
            }

            const nick = msg.nick.trim();

            if (nickExists(nick)) {
                ws.send(JSON.stringify({
                    type: "error",
                    text: "Ник занят"
                }));
                return;
            }

            ws.nick = nick;
            users.set(ws, nick);

            ws.send(JSON.stringify({
                type: "login_success",
                nick: nick
            }));

            sendUsers();

            broadcast({
                type: "system",
                text: `🟢 ${escapeHtml(nick)} вошёл`
            });

            return;
        }

        // Проверка что залогинен
        if (!ws.nick) {
            ws.send(JSON.stringify({
                type: "error",
                text: "Сначала логин"
            }));
            return;
        }

        /* ===== ОБЩИЙ ЧАТ ===== */
        if (msg.type === "chat") {
            if (!checkRate(ws)) return;

            const m = {
                id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
                text: escapeHtml(ws.nick) + ": " + escapeHtml((msg.text || "").slice(0, 300)),
                owner: ws.nick
            };

            history.push(m);
            history = history.slice(-200);
            savePublic();

            broadcast({
                type: "msg",
                data: m
            });
            return;
        }

        /* ===== ЛИЧНОЕ СООБЩЕНИЕ ===== */
        if (msg.type === "private_chat") {
            if (!checkRate(ws)) return;

            const targetNick = msg.target;
            const key = getPrivateKey(ws.nick, targetNick);

            if (!privateHistory[key]) {
                privateHistory[key] = [];
            }

            const m = {
                id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
                from: ws.nick,
                to: targetNick,
                text: escapeHtml((msg.text || "").slice(0, 300)),
                owner: ws.nick,
                time: Date.now()
            };

            privateHistory[key].push(m);
            privateHistory[key] = privateHistory[key].slice(-200);
            savePrivate();

            // Отправить отправителю
            ws.send(JSON.stringify({
                type: "private_msg",
                data: m,
                with: targetNick
            }));

            // Найти и отправить получателю
            let targetWs = null;
            for (const [c, nick] of users.entries()) {
                if (nick === targetNick) {
                    targetWs = c;
                    break;
                }
            }

            if (targetWs && targetWs.readyState === 1) {
                targetWs.send(JSON.stringify({
                    type: "private_msg",
                    data: m,
                    with: ws.nick
                }));
            }

            return;
        }

        /* ===== ЗАПРОС ИСТОРИИ ЛИЧНЫХ СООБЩЕНИЙ ===== */
        if (msg.type === "get_private_history") {
            const key = getPrivateKey(ws.nick, msg.with);
            ws.send(JSON.stringify({
                type: "private_history",
                with: msg.with,
                data: privateHistory[key] || []
            }));
            return;
        }

        /* ===== ЗАПРОС ИСТОРИИ ОБЩЕГО ЧАТА ===== */
        if (msg.type === "get_history") {
            ws.send(JSON.stringify({
                type: "history",
                data: history.slice(-200)
            }));
            return;
        }

        /* ===== УДАЛЕНИЕ СООБЩЕНИЯ ===== */
        if (msg.type === "delete") {
            let found = false;

            // Проверяем в общем чате
            const m = history.find(x => x.id === msg.id);
            if (m && m.owner === ws.nick) {
                history = history.filter(x => x.id !== msg.id);
                savePublic();
                broadcast({
                    type: "delete",
                    id: msg.id
                });
                found = true;
            }

            // Проверяем в личных чатах
            if (!found) {
                for (const key in privateHistory) {
                    const idx = privateHistory[key].findIndex(x => x.id === msg.id);
                    if (idx !== -1 && privateHistory[key][idx].owner === ws.nick) {
                        const deleted = privateHistory[key][idx];
                        privateHistory[key].splice(idx, 1);
                        savePrivate();

                        // Оповестить собеседника
                        const otherNick = deleted.from === ws.nick ? deleted.to : deleted.from;
                        let targetWs = null;
                        for (const [c, nick] of users.entries()) {
                            if (nick === otherNick) {
                                targetWs = c;
                                break;
                            }
                        }
                        if (targetWs && targetWs.readyState === 1) {
                            targetWs.send(JSON.stringify({
                                type: "delete",
                                id: msg.id
                            }));
                        }
                        ws.send(JSON.stringify({
                            type: "delete",
                            id: msg.id
                        }));
                        break;
                    }
                }
            }
            return;
        }

        /* ===== WEBRTC СИГНАЛИНГ (ЗВОНКИ) ===== */
        if (msg.type === "signal") {
            let targetWs = null;
            for (const [c, nick] of users.entries()) {
                if (nick === msg.target) {
                    targetWs = c;
                    break;
                }
            }
            if (targetWs && targetWs.readyState === 1) {
                targetWs.send(JSON.stringify({
                    type: "signal",
                    from: ws.nick,
                    signal: msg.signal
                }));
            }
            return;
        }
    });

    /* ===== ОТКЛЮЧЕНИЕ ===== */
    ws.on("close", () => {
        if (ws.nick) {
            users.delete(ws);
            rate.delete(ws);

            sendUsers();

            broadcast({
                type: "system",
                text: `🔴 ${escapeHtml(ws.nick)} вышел`
            });
        }
    });
});

/* ===== PING PONG (ПРОВЕРКА ЖИВЫХ СОЕДИНЕНИЙ) ===== */
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

server.listen(3000, () => {
    console.log("✅ Сервер запущен на порту 3000");
    console.log("   Открой http://localhost:3000");
});
