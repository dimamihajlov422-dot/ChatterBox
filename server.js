const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));
app.use("/files", express.static("files"));
app.use("/stickers", express.static("stickers"));

// Создаём папки если их нет
if (!fs.existsSync("files")) fs.mkdirSync("files");
if (!fs.existsSync("stickers")) fs.mkdirSync("stickers");

let history = [];
let privateHistory = {};
let usersOnline = new Map();      // ws -> nick
let sessions = new Map();         // token -> nick
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
} catch (e) { usersDB = {}; }

try {
    if (fs.existsSync(DB_FILE)) {
        history = JSON.parse(fs.readFileSync(DB_FILE, "utf8")) || [];
        console.log(`✅ Загружено ${history.length} сообщений из общего чата`);
    }
} catch { history = []; }

try {
    if (fs.existsSync(PRIVATE_FILE)) {
        privateHistory = JSON.parse(fs.readFileSync(PRIVATE_FILE, "utf8")) || {};
        console.log(`✅ Загружено ${Object.keys(privateHistory).length} диалогов`);
    }
} catch { privateHistory = {}; }

// ========== СОХРАНЕНИЕ ==========
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(usersDB, null, 2)); }
function savePublic() { fs.writeFileSync(DB_FILE, JSON.stringify(history.slice(-500), null, 2)); }
function savePrivate() { fs.writeFileSync(PRIVATE_FILE, JSON.stringify(privateHistory, null, 2)); }

// ========== ХЭШИРОВАНИЕ ==========
function hashPassword(password) {
    return crypto.createHash("sha256").update(password).digest("hex");
}

// ========== ГЕНЕРАЦИЯ ТОКЕНА ==========
function generateToken() {
    return crypto.randomBytes(32).toString("hex");
}

// ========== ФОРМАТИРОВАНИЕ ВРЕМЕНИ (МСК = UTC+3) ==========
function formatTime(timestamp) {
    const date = new Date(timestamp);
    date.setHours(date.getHours() + 3);
    return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

// ========== ЗАЩИТА ==========
function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function checkRate(ws) {
    const now = Date.now();
    if (!rate.has(ws)) rate.set(ws, []);
    const arr = rate.get(ws).filter(t => now - t < 1000);
    arr.push(now);
    rate.set(ws, arr);
    return arr.length <= 10;
}

function broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}

function sendUsers() {
    broadcast({ type: "users", users: Array.from(usersOnline.values()) });
}

function validNick(nick) {
    if (typeof nick !== "string") return false;
    nick = nick.trim();
    if (nick.length < 2 || nick.length > 16) return false;
    if (!/^[a-zA-Zа-яА-Я0-9_]+$/.test(nick)) return false;
    return true;
}

function nickExistsInDB(nick) { return !!usersDB[nick]; }
function nickExistsOnline(nick) {
    for (const u of usersOnline.values()) if (u === nick) return true;
    return false;
}

function getPrivateKey(user1, user2) { return [user1, user2].sort().join("_"); }

// ========== ОБНОВЛЕНИЕ РЕАКЦИЙ ==========
function updateReaction(id, from, reaction, remove = false) {
    // Общий чат
    let msg = history.find(x => x.id === id);
    if (msg) {
        if (!msg.reactions) msg.reactions = {};
        if (remove) delete msg.reactions[from];
        else msg.reactions[from] = reaction;
        savePublic();
        broadcast({ type: "reaction_update", id, from, reaction, remove });
        return true;
    }
    // Личные чаты
    for (const key in privateHistory) {
        const idx = privateHistory[key].findIndex(x => x.id === id);
        if (idx !== -1) {
            if (!privateHistory[key][idx].reactions) privateHistory[key][idx].reactions = {};
            if (remove) delete privateHistory[key][idx].reactions[from];
            else privateHistory[key][idx].reactions[from] = reaction;
            savePrivate();
            // Пересылаем всем участникам диалога
            const otherNick = privateHistory[key][idx].from === from ? privateHistory[key][idx].to : privateHistory[key][idx].from;
            let targetWs = null;
            for (const [c, nick] of usersOnline.entries()) if (nick === otherNick) { targetWs = c; break; }
            if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "reaction_update", id, from, reaction, remove }));
            broadcast({ type: "reaction_update", id, from, reaction, remove });
            return true;
        }
    }
    return false;
}

// ========== ОБНОВЛЕНИЕ ЗАКРЕПЛЕНИЯ ==========
function updatePinned(chatId, msgId, pinned) {
    if (chatId === "public") {
        const msg = history.find(x => x.id === msgId);
        if (msg) {
            msg.pinned = pinned;
            savePublic();
            broadcast({ type: "pinned_update", chatId, msgId, pinned, data: msg });
        }
    } else {
        const key = chatId;
        const msg = privateHistory[key]?.find(x => x.id === msgId);
        if (msg) {
            msg.pinned = pinned;
            savePrivate();
            const participants = key.split("_");
            for (const p of participants) {
                let targetWs = null;
                for (const [c, nick] of usersOnline.entries()) if (nick === p) { targetWs = c; break; }
                if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "pinned_update", chatId, msgId, pinned, data: msg }));
            }
        }
    }
}

// ========== WEBSOCKET ==========
wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => ws.isAlive = true);

    ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        // ===== АВТОВХОД ПО ТОКЕНУ =====
        if (msg.type === "auto_login") {
            const token = msg.token;
            const nick = sessions.get(token);
            if (nick && usersDB[nick] && !nickExistsOnline(nick)) {
                ws.nick = nick;
                usersOnline.set(ws, nick);
                ws.send(JSON.stringify({ type: "login_success", nick: nick, profile: usersDB[nick].profile || {} }));
                sendUsers();
                broadcast({ type: "system", text: `🟢 ${escapeHtml(nick)} вошёл` });
            } else {
                ws.send(JSON.stringify({ type: "error", text: "Сессия устарела" }));
            }
            return;
        }

        // ===== РЕГИСТРАЦИЯ =====
        if (msg.type === "register") {
            const nick = msg.nick?.trim();
            const password = msg.password?.trim();
            if (!validNick(nick)) { ws.send(JSON.stringify({ type: "error", text: "Ник 2-16 символов" })); return; }
            if (!password || password.length < 3) { ws.send(JSON.stringify({ type: "error", text: "Пароль минимум 3 символа" })); return; }
            if (nickExistsInDB(nick)) { ws.send(JSON.stringify({ type: "error", text: "Пользователь уже существует" })); return; }
            usersDB[nick] = {
                password: hashPassword(password),
                created: new Date().toISOString(),
                profile: { bio: "", age: "", avatar: null, stickers: [] }
            };
            saveUsers();
            ws.send(JSON.stringify({ type: "register_success", text: "Регистрация успешна! Теперь войдите." }));
            return;
        }

        // ===== ЛОГИН =====
        if (msg.type === "login") {
            const nick = msg.nick?.trim();
            const password = msg.password?.trim();
            const remember = msg.remember || false;

            if (!validNick(nick)) { ws.send(JSON.stringify({ type: "error", text: "Неверный ник" })); return; }
            if (!password) { ws.send(JSON.stringify({ type: "error", text: "Введите пароль" })); return; }
            if (!nickExistsInDB(nick)) { ws.send(JSON.stringify({ type: "error", text: "Пользователь не найден" })); return; }
            if (usersDB[nick].password !== hashPassword(password)) { ws.send(JSON.stringify({ type: "error", text: "Неверный пароль" })); return; }
            if (nickExistsOnline(nick)) { ws.send(JSON.stringify({ type: "error", text: "Уже в сети" })); return; }

            ws.nick = nick;
            usersOnline.set(ws, nick);

            let token = null;
            if (remember) {
                token = generateToken();
                sessions.set(token, nick);
            }

            ws.send(JSON.stringify({
                type: "login_success",
                nick: nick,
                profile: usersDB[nick].profile || {},
                token: token
            }));

            sendUsers();
            broadcast({ type: "system", text: `🟢 ${escapeHtml(nick)} вошёл` });
            return;
        }

        if (!ws.nick) { ws.send(JSON.stringify({ type: "error", text: "Сначала войдите" })); return; }

        // ===== ПОЛУЧИТЬ ПРОФИЛЬ =====
        if (msg.type === "get_profile") {
            const targetNick = msg.nick;
            if (usersDB[targetNick]) {
                ws.send(JSON.stringify({ type: "profile_data", nick: targetNick, profile: usersDB[targetNick].profile || {} }));
            }
            return;
        }

        // ===== ОБНОВИТЬ ПРОФИЛЬ =====
        if (msg.type === "update_profile") {
            if (!usersDB[ws.nick]) usersDB[ws.nick] = {};
            if (!usersDB[ws.nick].profile) usersDB[ws.nick].profile = {};
            if (msg.bio !== undefined) usersDB[ws.nick].profile.bio = escapeHtml(msg.bio.slice(0, 200));
            if (msg.age !== undefined) usersDB[ws.nick].profile.age = escapeHtml(msg.age.slice(0, 3));
            if (msg.avatar !== undefined) usersDB[ws.nick].profile.avatar = msg.avatar;
            if (msg.newSticker !== undefined) {
                if (!usersDB[ws.nick].profile.stickers) usersDB[ws.nick].profile.stickers = [];
                usersDB[ws.nick].profile.stickers.push(msg.newSticker);
            }
            saveUsers();
            ws.send(JSON.stringify({ type: "profile_updated", profile: usersDB[ws.nick].profile }));
            return;
        }

        // ===== ПЕЧАТАЕТ =====
        if (msg.type === "typing") {
            const targetNick = msg.to;
            let targetWs = null;
            for (const [c, nick] of usersOnline.entries()) if (nick === targetNick) { targetWs = c; break; }
            if (targetWs && targetWs.readyState === 1) {
                targetWs.send(JSON.stringify({ type: "typing", from: ws.nick, isTyping: msg.isTyping }));
            }
            return;
        }

        // ===== ОБЩИЙ ЧАТ =====
        if (msg.type === "chat") {
            if (!checkRate(ws)) return;
            const m = {
                id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
                text: escapeHtml((msg.text || "").slice(0, 500)),
                image: msg.image || null,
                file: msg.file || null,
                sticker: msg.sticker || null,
                replyTo: msg.replyTo || null,
                owner: ws.nick,
                time: Date.now(),
                timeFormatted: formatTime(Date.now()),
                reactions: {},
                pinned: false
            };
            history.push(m);
            history = history.slice(-500);
            savePublic();
            broadcast({ type: "msg", data: m });
            return;
        }

        // ===== ЛИЧНОЕ СООБЩЕНИЕ =====
        if (msg.type === "private_chat") {
            if (!checkRate(ws)) return;
            const targetNick = msg.target;
            const key = getPrivateKey(ws.nick, targetNick);
            if (!privateHistory[key]) privateHistory[key] = [];
            const m = {
                id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
                from: ws.nick,
                to: targetNick,
                text: escapeHtml((msg.text || "").slice(0, 500)),
                image: msg.image || null,
                file: msg.file || null,
                sticker: msg.sticker || null,
                replyTo: msg.replyTo || null,
                owner: ws.nick,
                time: Date.now(),
                timeFormatted: formatTime(Date.now()),
                reactions: {},
                pinned: false
            };
            privateHistory[key].push(m);
            privateHistory[key] = privateHistory[key].slice(-500);
            savePrivate();
            ws.send(JSON.stringify({ type: "private_msg", data: m, with: targetNick }));
            let targetWs = null;
            for (const [c, nick] of usersOnline.entries()) if (nick === targetNick) { targetWs = c; break; }
            if (targetWs && targetWs.readyState === 1) {
                targetWs.send(JSON.stringify({ type: "private_msg", data: m, with: ws.nick }));
            }
            return;
        }

        // ===== РЕАКЦИЯ =====
        if (msg.type === "reaction") {
            updateReaction(msg.id, ws.nick, msg.reaction, msg.remove);
            return;
        }

        // ===== ЗАКРЕПИТЬ =====
        if (msg.type === "pin") {
            updatePinned(msg.chatId, msg.id, msg.pinned);
            return;
        }

        // ===== РЕДАКТИРОВАНИЕ =====
        if (msg.type === "edit") {
            let found = false;
            const m = history.find(x => x.id === msg.id);
            if (m && m.owner === ws.nick) {
                m.text = escapeHtml(msg.text.slice(0, 500));
                savePublic();
                broadcast({ type: "edit", id: msg.id, newText: m.text });
                found = true;
            }
            if (!found) {
                for (const key in privateHistory) {
                    const idx = privateHistory[key].findIndex(x => x.id === msg.id);
                    if (idx !== -1 && privateHistory[key][idx].owner === ws.nick) {
                        privateHistory[key][idx].text = escapeHtml(msg.text.slice(0, 500));
                        savePrivate();
                        const otherNick = privateHistory[key][idx].from === ws.nick ? privateHistory[key][idx].to : privateHistory[key][idx].from;
                        let targetWs = null;
                        for (const [c, nick] of usersOnline.entries()) if (nick === otherNick) { targetWs = c; break; }
                        if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "edit", id: msg.id, newText: privateHistory[key][idx].text }));
                        ws.send(JSON.stringify({ type: "edit", id: msg.id, newText: privateHistory[key][idx].text }));
                        break;
                    }
                }
            }
            return;
        }

        // ===== УДАЛЕНИЕ =====
        if (msg.type === "delete") {
            let found = false;
            const m = history.find(x => x.id === msg.id);
            if (m && m.owner === ws.nick) {
                history = history.filter(x => x.id !== msg.id);
                savePublic();
                broadcast({ type: "delete", id: msg.id });
                found = true;
            }
            if (!found) {
                for (const key in privateHistory) {
                    const idx = privateHistory[key].findIndex(x => x.id === msg.id);
                    if (idx !== -1 && privateHistory[key][idx].owner === ws.nick) {
                        const deleted = privateHistory[key][idx];
                        privateHistory[key].splice(idx, 1);
                        savePrivate();
                        const otherNick = deleted.from === ws.nick ? deleted.to : deleted.from;
                        let targetWs = null;
                        for (const [c, nick] of usersOnline.entries()) if (nick === otherNick) { targetWs = c; break; }
                        if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "delete", id: msg.id }));
                        ws.send(JSON.stringify({ type: "delete", id: msg.id }));
                        break;
                    }
                }
            }
            return;
        }

        // ===== ЗАПРОС ИСТОРИИ =====
        if (msg.type === "get_private_history") {
            const key = getPrivateKey(ws.nick, msg.with);
            const data = (privateHistory[key] || []).map(m => ({ ...m, timeFormatted: formatTime(m.time) }));
            ws.send(JSON.stringify({ type: "private_history", with: msg.with, data: data }));
            return;
        }
        if (msg.type === "get_history") {
            ws.send(JSON.stringify({ type: "history", data: history.slice(-500).map(m => ({ ...m, timeFormatted: formatTime(m.time) })) }));
            return;
        }

        // ===== ЗАГРУЗКА ФАЙЛА =====
        if (msg.type === "upload_file") {
            const filename = Date.now() + "_" + ws.nick + "_" + msg.filename;
            const filepath = path.join("files", filename);
            const buffer = Buffer.from(msg.data, "base64");
            fs.writeFileSync(filepath, buffer);
            ws.send(JSON.stringify({ type: "file_uploaded", url: `/files/${filename}`, filename: msg.filename, size: buffer.length }));
            return;
        }

        // ===== ЗАГРУЗКА СТИКЕРА =====
        if (msg.type === "upload_sticker") {
            const filename = Date.now() + "_" + ws.nick + ".png";
            const filepath = path.join("stickers", filename);
            const buffer = Buffer.from(msg.data, "base64");
            fs.writeFileSync(filepath, buffer);
            if (!usersDB[ws.nick].profile.stickers) usersDB[ws.nick].profile.stickers = [];
            usersDB[ws.nick].profile.stickers.push(`/stickers/${filename}`);
            saveUsers();
            ws.send(JSON.stringify({ type: "sticker_uploaded", url: `/stickers/${filename}` }));
            return;
        }

        // ===== WEBRTC =====
        if (msg.type === "signal") {
            let targetWs = null;
            for (const [c, nick] of usersOnline.entries()) if (nick === msg.target) { targetWs = c; break; }
            if (targetWs && targetWs.readyState === 1) {
                targetWs.send(JSON.stringify({ type: "signal", from: ws.nick, signal: msg.signal }));
            }
            return;
        }
    });

    ws.on("close", () => {
        if (ws.nick) {
            usersOnline.delete(ws);
            rate.delete(ws);
            sendUsers();
            broadcast({ type: "system", text: `🔴 ${escapeHtml(ws.nick)} вышел` });
        }
    });
});

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
    console.log("");
    console.log("📱 Поддерживаются функции:");
    console.log("   • Регистрация и вход с запоминанием");
    console.log("   • Общий чат с никами");
    console.log("   • Личные сообщения");
    console.log("   • Отправка картинок, файлов, стикеров");
    console.log("   • Редактирование, удаление, ответ");
    console.log("   • Профиль пользователя");
    console.log("   • Реакции 👍❤️😂😮😢😡");
    console.log("   • Закрепление сообщений");
    console.log("   • Статус печатает...");
    console.log("   • WebRTC звонки");
});
