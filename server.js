const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

let history = [];
let privateHistory = {};
let usersOnline = new Map();
let rate = new Map();
let usersDB = {};

const DB_FILE = "db.json";
const PRIVATE_FILE = "private.json";
const USERS_FILE = "users.json";

// ========== ЗАГРУЗКА ==========
try {
    if (fs.existsSync(USERS_FILE)) {
        usersDB = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")) || {};
        console.log(`✅ Загружено ${Object.keys(usersDB).length} пользователей`);
    } else {
        fs.writeFileSync(USERS_FILE, JSON.stringify({}, null, 2));
        usersDB = {};
    }
} catch (e) {
    usersDB = {};
}

try {
    if (fs.existsSync(DB_FILE)) {
        history = JSON.parse(fs.readFileSync(DB_FILE, "utf8")) || [];
        console.log(`✅ Загружено ${history.length} сообщений из общего чата`);
    }
} catch {
    history = [];
}

try {
    if (fs.existsSync(PRIVATE_FILE)) {
        privateHistory = JSON.parse(fs.readFileSync(PRIVATE_FILE, "utf8")) || {};
        console.log(`✅ Загружено ${Object.keys(privateHistory).length} диалогов`);
    }
} catch {
    privateHistory = {};
}

// ========== СОХРАНЕНИЕ ==========
function saveUsers() {
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersDB, null, 2));
}

function savePublic() {
    fs.writeFileSync(DB_FILE, JSON.stringify(history.slice(-500), null, 2));
}

function savePrivate() {
    fs.writeFileSync(PRIVATE_FILE, JSON.stringify(privateHistory, null, 2));
}

// ========== ХЭШИРОВАНИЕ ==========
function hashPassword(password) {
    return crypto.createHash("sha256").update(password).digest("hex");
}

// ========== ЗАЩИТА XSS ==========
function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// ========== ЗАЩИТА ОТ СПАМА ==========
function checkRate(ws) {
    const now = Date.now();
    if (!rate.has(ws)) rate.set(ws, []);
    const arr = rate.get(ws).filter(t => now - t < 1000);
    arr.push(now);
    rate.set(ws, arr);
    return arr.length <= 10;
}

// ========== РАССЫЛКА ==========
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
        users: Array.from(usersOnline.values())
    });
}

// ========== ВАЛИДАЦИЯ ==========
function validNick(nick) {
    if (typeof nick !== "string") return false;
    nick = nick.trim();
    if (nick.length < 2 || nick.length > 16) return false;
    if (!/^[a-zA-Zа-яА-Я0-9_]+$/.test(nick)) return false;
    return true;
}

function nickExistsInDB(nick) {
    return !!usersDB[nick];
}

function nickExistsOnline(nick) {
    for (const u of usersOnline.values()) {
        if (u === nick) return true;
    }
    return false;
}

function getPrivateKey(user1, user2) {
    return [user1, user2].sort().join("_");
}

// ========== WEBSOCKET ==========
wss.on("connection", (ws) => {
    ws.isAlive = true;

    ws.on("pong", () => {
        ws.isAlive = true;
    });

    // Отправляем начальные данные
    ws.send(JSON.stringify({
        type: "history",
        data: history.slice(-500)
    }));

    ws.send(JSON.stringify({
        type: "users",
        users: Array.from(usersOnline.values())
    }));

    ws.on("message", (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }

        // ===== РЕГИСТРАЦИЯ =====
        if (msg.type === "register") {
            const nick = msg.nick?.trim();
            const password = msg.password?.trim();

            if (!validNick(nick)) {
                ws.send(JSON.stringify({ type: "error", text: "Ник 2-16 символов (буквы/цифры/_)" }));
                return;
            }

            if (!password || password.length < 3) {
                ws.send(JSON.stringify({ type: "error", text: "Пароль минимум 3 символа" }));
                return;
            }

            if (nickExistsInDB(nick)) {
                ws.send(JSON.stringify({ type: "error", text: "Пользователь уже существует" }));
                return;
            }

            usersDB[nick] = {
                password: hashPassword(password),
                created: new Date().toISOString()
            };
            saveUsers();

            ws.send(JSON.stringify({ type: "register_success", text: "Регистрация успешна! Теперь войдите." }));
            return;
        }

        // ===== ЛОГИН =====
        if (msg.type === "login") {
            const nick = msg.nick?.trim();
            const password = msg.password?.trim();

            if (!validNick(nick)) {
                ws.send(JSON.stringify({ type: "error", text: "Неверный ник или пароль" }));
                return;
            }

            if (!password) {
                ws.send(JSON.stringify({ type: "error", text: "Введите пароль" }));
                return;
            }

            if (!nickExistsInDB(nick)) {
                ws.send(JSON.stringify({ type: "error", text: "Пользователь не найден" }));
                return;
            }

            if (usersDB[nick].password !== hashPassword(password)) {
                ws.send(JSON.stringify({ type: "error", text: "Неверный пароль" }));
                return;
            }

            if (nickExistsOnline(nick)) {
                ws.send(JSON.stringify({ type: "error", text: "Этот пользователь уже в сети" }));
                return;
            }

            ws.nick = nick;
            usersOnline.set(ws, nick);

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
            ws.send(JSON.stringify({ type: "error", text: "Сначала войдите" }));
            return;
        }

        // ===== ОБЩИЙ ЧАТ =====
        if (msg.type === "chat") {
            if (!checkRate(ws)) return;

            const m = {
                id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
                text: escapeHtml((msg.text || "").slice(0, 500)),
                image: msg.image || null,
                replyTo: msg.replyTo || null,
                owner: ws.nick,
                time: Date.now()
            };

            history.push(m);
            history = history.slice(-500);
            savePublic();

            broadcast({
                type: "msg",
                data: m
            });
            return;
        }

        // ===== ЛИЧНОЕ СООБЩЕНИЕ =====
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
                text: escapeHtml((msg.text || "").slice(0, 500)),
                image: msg.image || null,
                replyTo: msg.replyTo || null,
                owner: ws.nick,
                time: Date.now()
            };

            privateHistory[key].push(m);
            privateHistory[key] = privateHistory[key].slice(-500);
            savePrivate();

            // Отправить отправителю
            ws.send(JSON.stringify({
                type: "private_msg",
                data: m,
                with: targetNick
            }));

            // Найти и отправить получателю
            let targetWs = null;
            for (const [c, nick] of usersOnline.entries()) {
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

        // ===== РЕДАКТИРОВАНИЕ СООБЩЕНИЯ =====
        if (msg.type === "edit") {
            let found = false;

            // Проверяем в общем чате
            const m = history.find(x => x.id === msg.id);
            if (m && m.owner === ws.nick) {
                m.text = escapeHtml(msg.text.slice(0, 500));
                savePublic();
                broadcast({
                    type: "edit",
                    id: msg.id,
                    newText: m.text
                });
                found = true;
            }

            // Проверяем в личных чатах
            if (!found) {
                for (const key in privateHistory) {
                    const idx = privateHistory[key].findIndex(x => x.id === msg.id);
                    if (idx !== -1 && privateHistory[key][idx].owner === ws.nick) {
                        privateHistory[key][idx].text = escapeHtml(msg.text.slice(0, 500));
                        savePrivate();

                        const otherNick = privateHistory[key][idx].from === ws.nick 
                            ? privateHistory[key][idx].to 
                            : privateHistory[key][idx].from;

                        let targetWs = null;
                        for (const [c, nick] of usersOnline.entries()) {
                            if (nick === otherNick) {
                                targetWs = c;
                                break;
                            }
                        }

                        if (targetWs && targetWs.readyState === 1) {
                            targetWs.send(JSON.stringify({
                                type: "edit",
                                id: msg.id,
                                newText: privateHistory[key][idx].text
                            }));
                        }

                        ws.send(JSON.stringify({
                            type: "edit",
                            id: msg.id,
                            newText: privateHistory[key][idx].text
                        }));
                        break;
                    }
                }
            }
            return;
        }

        // ===== УДАЛЕНИЕ СООБЩЕНИЯ =====
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

                        const otherNick = deleted.from === ws.nick ? deleted.to : deleted.from;

                        let targetWs = null;
                        for (const [c, nick] of usersOnline.entries()) {
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

        // ===== ЗАПРОС ИСТОРИИ =====
        if (msg.type === "get_private_history") {
            const key = getPrivateKey(ws.nick, msg.with);
            ws.send(JSON.stringify({
                type: "private_history",
                with: msg.with,
                data: privateHistory[key] || []
            }));
            return;
        }

        if (msg.type === "get_history") {
            ws.send(JSON.stringify({
                type: "history",
                data: history.slice(-500)
            }));
            return;
        }

        // ===== WEBRTC СИГНАЛИНГ (ЗВОНКИ) =====
        if (msg.type === "signal") {
            let targetWs = null;
            for (const [c, nick] of usersOnline.entries()) {
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

    // ===== ОТКЛЮЧЕНИЕ =====
    ws.on("close", () => {
        if (ws.nick) {
            usersOnline.delete(ws);
            rate.delete(ws);

            sendUsers();

            broadcast({
                type: "system",
                text: `🔴 ${escapeHtml(ws.nick)} вышел`
            });
        }
    });
});

// ===== PING PONG (ПРОВЕРКА ЖИВЫХ СОЕДИНЕНИЙ) =====
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

server.listen(3000, () => {
    console.log("✅ Сервер запущен на порту 3000");
    console.log("   http://localhost:3000");
    console.log("   Поддерживаются: картинки, редактирование, ответы, ЛС, звонки");
});
