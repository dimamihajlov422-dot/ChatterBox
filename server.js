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
app.use("/music", express.static("music"));
app.use("/voice", express.static("voice"));

if (!fs.existsSync("files")) fs.mkdirSync("files");
if (!fs.existsSync("music")) fs.mkdirSync("music");
if (!fs.existsSync("voice")) fs.mkdirSync("voice");

let history = [];
let privateHistory = {};
let groups = {};
let usersOnline = new Map();
let userStatus = new Map();
let sessions = new Map();
let rate = new Map();
let usersDB = {};

const DB_FILE = "db.json";
const PRIVATE_FILE = "private.json";
const GROUPS_FILE = "groups.json";
const USERS_FILE = "users.json";

function loadData() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            usersDB = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")) || {};
            console.log(`✅ Загружено ${Object.keys(usersDB).length} пользователей`);
        } else {
            usersDB = {};
            fs.writeFileSync(USERS_FILE, JSON.stringify({}, null, 2));
        }
    } catch (e) { usersDB = {}; }
    try {
        if (fs.existsSync(DB_FILE)) {
            history = JSON.parse(fs.readFileSync(DB_FILE, "utf8")) || [];
            console.log(`✅ Загружено ${history.length} сообщений`);
        } else {
            history = [];
            fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
        }
    } catch (e) { history = []; }
    try {
        if (fs.existsSync(PRIVATE_FILE)) {
            privateHistory = JSON.parse(fs.readFileSync(PRIVATE_FILE, "utf8")) || {};
            console.log(`✅ Загружено ${Object.keys(privateHistory).length} диалогов`);
        } else {
            privateHistory = {};
            fs.writeFileSync(PRIVATE_FILE, JSON.stringify({}, null, 2));
        }
    } catch (e) { privateHistory = {}; }
    try {
        if (fs.existsSync(GROUPS_FILE)) {
            groups = JSON.parse(fs.readFileSync(GROUPS_FILE, "utf8")) || {};
            console.log(`✅ Загружено ${Object.keys(groups).length} групп`);
        } else {
            groups = {};
            fs.writeFileSync(GROUPS_FILE, JSON.stringify({}, null, 2));
        }
    } catch (e) { groups = {}; }
}

loadData();

function saveUsers() { try { fs.writeFileSync(USERS_FILE, JSON.stringify(usersDB, null, 2)); } catch (e) {} }
function savePublic() { try { fs.writeFileSync(DB_FILE, JSON.stringify(history.slice(-500), null, 2)); } catch (e) {} }
function savePrivate() { try { fs.writeFileSync(PRIVATE_FILE, JSON.stringify(privateHistory, null, 2)); } catch (e) {} }
function saveGroups() { try { fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2)); } catch (e) {} }

function hashPassword(password) { return crypto.createHash("sha256").update(password).digest("hex"); }
function generateToken() { return crypto.randomBytes(32).toString("hex"); }
function formatTime(timestamp) { const date = new Date(timestamp); date.setHours(date.getHours() + 3); return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); }
function escapeHtml(str) { if (!str) return ""; return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function checkRate(ws) { const now = Date.now(); if (!rate.has(ws)) rate.set(ws, []); const arr = rate.get(ws).filter(t => now - t < 1000); arr.push(now); rate.set(ws, arr); return arr.length <= 10; }
function broadcast(obj) { const data = JSON.stringify(obj); for (const c of wss.clients) if (c.readyState === 1) c.send(data); }
function sendUsers() { broadcast({ type: "users", users: Array.from(usersOnline.values()), statuses: Object.fromEntries(userStatus) }); }
function validNick(nick) { nick = nick?.trim(); if (!nick || nick.length < 2 || nick.length > 16) return false; return /^[a-zA-Zа-яА-Я0-9_]+$/.test(nick); }
function nickExistsInDB(nick) { return !!usersDB[nick]; }
function getPrivateKey(u1, u2) { return [u1, u2].sort().join("_"); }
function isDima(nick) { return nick === "Дима"; }

function createGroup(name, creator) {
    const id = Date.now().toString() + "-" + Math.random().toString(36).substr(2, 6);
    groups[id] = { id, name: escapeHtml(name), creator, members: [creator], messages: [], avatar: null, isChannel: false, createdAt: Date.now() };
    saveGroups();
    return id;
}
function createChannel(name, creator) {
    const id = Date.now().toString() + "-" + Math.random().toString(36).substr(2, 6);
    groups[id] = { id, name: escapeHtml(name), creator, members: [creator], messages: [], avatar: null, isChannel: true, createdAt: Date.now() };
    saveGroups();
    return id;
}
function updateGroupName(groupId, newName, requester) {
    if (!groups[groupId]) return false;
    if (groups[groupId].creator !== requester && !isDima(requester)) return false;
    groups[groupId].name = escapeHtml(newName);
    saveGroups();
    for (const member of groups[groupId].members) {
        let targetWs = null;
        for (const [c, n] of usersOnline.entries()) if (n === member) { targetWs = c; break; }
        if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "group_update", group: groups[groupId] }));
    }
    return true;
}
function addToGroup(groupId, nick, adder) {
    if (!groups[groupId] || groups[groupId].members.includes(nick)) return false;
    groups[groupId].members.push(nick);
    saveGroups();
    for (const member of groups[groupId].members) {
        let targetWs = null;
        for (const [c, n] of usersOnline.entries()) if (n === member) { targetWs = c; break; }
        if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "group_update", group: groups[groupId] }));
    }
    return true;
}
function removeFromGroup(groupId, nick, remover) {
    if (!groups[groupId]) return false;
    if (groups[groupId].creator !== remover && !isDima(remover)) return false;
    if (nick === groups[groupId].creator && !isDima(remover)) return false;
    groups[groupId].members = groups[groupId].members.filter(m => m !== nick);
    saveGroups();
    for (const member of groups[groupId].members) {
        let targetWs = null;
        for (const [c, n] of usersOnline.entries()) if (n === member) { targetWs = c; break; }
        if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "group_update", group: groups[groupId] }));
    }
    return true;
}
function sendGroupMessage(groupId, from, msgData) {
    if (!groups[groupId]) return;
    if (groups[groupId].isChannel && groups[groupId].creator !== from && !isDima(from)) return;
    const m = {
        id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
        from, text: escapeHtml((msgData.text || "").slice(0, 500)), image: msgData.image || null, video: msgData.video || null, file: msgData.file || null, music: msgData.music || null, voice: msgData.voice || null, location: msgData.location || null,
        replyTo: msgData.replyTo || null, time: Date.now(), timeFormatted: formatTime(Date.now()), reactions: {}
    };
    groups[groupId].messages.push(m);
    groups[groupId].messages = groups[groupId].messages.slice(-500);
    saveGroups();
    for (const member of groups[groupId].members) {
        let targetWs = null;
        for (const [c, n] of usersOnline.entries()) if (n === member) { targetWs = c; break; }
        if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "group_msg", groupId, data: m }));
    }
}

function updateLastChat(nick, chatType, chatId, lastMessage) {
    if (!usersDB[nick]) usersDB[nick] = {};
    if (!usersDB[nick].lastChats) usersDB[nick].lastChats = [];
    const existing = usersDB[nick].lastChats.find(c => c.chatId === chatId);
    if (existing) { existing.lastMessage = lastMessage; existing.timestamp = Date.now(); }
    else { usersDB[nick].lastChats.unshift({ chatType, chatId, lastMessage, timestamp: Date.now() }); }
    usersDB[nick].lastChats = usersDB[nick].lastChats.slice(0, 20);
    saveUsers();
}
function getLastChats(nick) { return (usersDB[nick]?.lastChats || []).sort((a, b) => b.timestamp - a.timestamp); }

function updateReaction(type, id, from, reaction, remove) {
    let target = null;
    if (type === "public") target = history.find(x => x.id === id);
    else if (type === "private") { for (const key in privateHistory) { const idx = privateHistory[key].findIndex(x => x.id === id); if (idx !== -1) { target = privateHistory[key][idx]; break; } } }
    else if (type === "group") { for (const gid in groups) { const idx = groups[gid].messages.findIndex(x => x.id === id); if (idx !== -1) { target = groups[gid].messages[idx]; break; } } }
    if (!target) return;
    if (!target.reactions) target.reactions = {};
    if (remove) delete target.reactions[from];
    else target.reactions[from] = reaction;
    if (type === "public") savePublic(); else if (type === "private") savePrivate(); else if (type === "group") saveGroups();
    broadcast({ type: "reaction_update", id, from, reaction, remove });
}

wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => ws.isAlive = true);

    ws.on("message", (raw) => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }

        if (msg.type === "auto_login") {
            const token = msg.token;
            const nick = sessions.get(token);
            if (nick && usersDB[nick]) {
                ws.nick = nick; usersOnline.set(ws, nick);
                userStatus.set(nick, { status: "online", lastSeen: Date.now() });
                ws.send(JSON.stringify({ type: "login_success", nick: nick, profile: usersDB[nick].profile || {}, groups: Object.values(groups).filter(g => g.members.includes(nick)), lastChats: getLastChats(nick) }));
                sendUsers(); broadcast({ type: "system", text: `🟢 ${escapeHtml(nick)} вошёл` });
            } else ws.send(JSON.stringify({ type: "error", text: "Сессия устарела" }));
            return;
        }

        if (msg.type === "register") {
            const nick = msg.nick?.trim(); const password = msg.password?.trim();
            if (!validNick(nick)) { ws.send(JSON.stringify({ type: "error", text: "Ник 2-16 символов" })); return; }
            if (!password || password.length < 3) { ws.send(JSON.stringify({ type: "error", text: "Пароль минимум 3 символа" })); return; }
            if (nickExistsInDB(nick)) { ws.send(JSON.stringify({ type: "error", text: "Пользователь уже существует" })); return; }
            usersDB[nick] = { password: hashPassword(password), created: new Date().toISOString(), profile: { bio: "", age: "", phone: "", avatar: null }, lastChats: [] };
            saveUsers();
            ws.send(JSON.stringify({ type: "register_success", text: "Регистрация успешна! Теперь войдите." }));
            return;
        }

        if (msg.type === "login") {
            const nick = msg.nick?.trim(); const password = msg.password?.trim(); const remember = msg.remember || false;
            if (!validNick(nick)) { ws.send(JSON.stringify({ type: "error", text: "Неверный ник" })); return; }
            if (!password) { ws.send(JSON.stringify({ type: "error", text: "Введите пароль" })); return; }
            if (!nickExistsInDB(nick)) { ws.send(JSON.stringify({ type: "error", text: "Пользователь не найден" })); return; }
            if (usersDB[nick].password !== hashPassword(password)) { ws.send(JSON.stringify({ type: "error", text: "Неверный пароль" })); return; }
            ws.nick = nick; usersOnline.set(ws, nick);
            userStatus.set(nick, { status: "online", lastSeen: Date.now() });
            let token = null; if (remember) { token = generateToken(); sessions.set(token, nick); }
            ws.send(JSON.stringify({ type: "login_success", nick: nick, profile: usersDB[nick].profile || {}, token: token, groups: Object.values(groups).filter(g => g.members.includes(nick)), lastChats: getLastChats(nick) }));
            sendUsers(); broadcast({ type: "system", text: `🟢 ${escapeHtml(nick)} вошёл` });
            return;
        }

        if (!ws.nick) { ws.send(JSON.stringify({ type: "error", text: "Сначала войдите" })); return; }

        if (msg.type === "update_status") {
            userStatus.set(ws.nick, { status: msg.status, lastSeen: Date.now() });
            sendUsers();
            return;
        }

        if (msg.type === "get_profile") {
            if (usersDB[msg.nick]) ws.send(JSON.stringify({ type: "profile_data", nick: msg.nick, profile: usersDB[msg.nick].profile || {} }));
            return;
        }
        if (msg.type === "update_profile") {
            if (!usersDB[ws.nick].profile) usersDB[ws.nick].profile = {};
            if (msg.bio !== undefined) usersDB[ws.nick].profile.bio = escapeHtml(msg.bio.slice(0, 200));
            if (msg.age !== undefined) usersDB[ws.nick].profile.age = escapeHtml(msg.age.slice(0, 3));
            if (msg.phone !== undefined) usersDB[ws.nick].profile.phone = escapeHtml(msg.phone.slice(0, 20));
            if (msg.avatar !== undefined) usersDB[ws.nick].profile.avatar = msg.avatar;
            saveUsers();
            ws.send(JSON.stringify({ type: "profile_updated", profile: usersDB[ws.nick].profile }));
            return;
        }

        if (msg.type === "update_group_avatar") {
            if (groups[msg.groupId]) {
                groups[msg.groupId].avatar = msg.avatar;
                saveGroups();
                for (const member of groups[msg.groupId].members) {
                    let targetWs = null;
                    for (const [c, n] of usersOnline.entries()) if (n === member) { targetWs = c; break; }
                    if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "group_update", group: groups[msg.groupId] }));
                }
            }
            return;
        }

        if (msg.type === "update_group_name") {
            if (updateGroupName(msg.groupId, msg.newName, ws.nick)) {
                ws.send(JSON.stringify({ type: "group_name_updated", groupId: msg.groupId, newName: msg.newName }));
            }
            return;
        }

        if (msg.type === "typing") {
            let targetWs = null;
            for (const [c, nick] of usersOnline.entries()) if (nick === msg.to) { targetWs = c; break; }
            if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "typing", from: ws.nick, isTyping: msg.isTyping }));
            return;
        }

        if (msg.type === "chat") {
            if (!checkRate(ws)) return;
            const m = { id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8), text: escapeHtml((msg.text || "").slice(0, 500)), image: msg.image || null, video: msg.video || null, file: msg.file || null, music: msg.music || null, voice: msg.voice || null, location: msg.location || null, replyTo: msg.replyTo || null, owner: ws.nick, time: Date.now(), timeFormatted: formatTime(Date.now()), reactions: {} };
            history.push(m); history = history.slice(-500); savePublic();
            updateLastChat(ws.nick, "public", "public", m.text || "📷 Вложение");
            broadcast({ type: "msg", data: m });
            return;
        }

        if (msg.type === "private_chat") {
            if (!checkRate(ws)) return;
            const key = getPrivateKey(ws.nick, msg.target);
            if (!privateHistory[key]) privateHistory[key] = [];
            const m = { id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8), from: ws.nick, to: msg.target, text: escapeHtml((msg.text || "").slice(0, 500)), image: msg.image || null, video: msg.video || null, file: msg.file || null, music: msg.music || null, voice: msg.voice || null, location: msg.location || null, replyTo: msg.replyTo || null, owner: ws.nick, time: Date.now(), timeFormatted: formatTime(Date.now()), reactions: {} };
            privateHistory[key].push(m); privateHistory[key] = privateHistory[key].slice(-500); savePrivate();
            updateLastChat(ws.nick, "private", msg.target, m.text || "📷 Вложение");
            updateLastChat(msg.target, "private", ws.nick, m.text || "📷 Вложение");
            ws.send(JSON.stringify({ type: "private_msg", data: m, with: msg.target }));
            let targetWs = null; for (const [c, nick] of usersOnline.entries()) if (nick === msg.target) { targetWs = c; break; }
            if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "private_msg", data: m, with: ws.nick }));
            return;
        }

        if (msg.type === "create_group") { const groupId = createGroup(msg.name, ws.nick); ws.send(JSON.stringify({ type: "group_created", group: groups[groupId] })); return; }
        if (msg.type === "create_channel") { const groupId = createChannel(msg.name, ws.nick); ws.send(JSON.stringify({ type: "group_created", group: groups[groupId] })); return; }
        if (msg.type === "invite_to_group") { if (addToGroup(msg.groupId, msg.nick, ws.nick)) ws.send(JSON.stringify({ type: "invite_sent", groupId: msg.groupId, nick: msg.nick })); return; }
        if (msg.type === "remove_from_group") { if (removeFromGroup(msg.groupId, msg.nick, ws.nick)) ws.send(JSON.stringify({ type: "remove_sent", groupId: msg.groupId, nick: msg.nick })); return; }
        if (msg.type === "group_chat") { if (!checkRate(ws)) return; sendGroupMessage(msg.groupId, ws.nick, msg); for (const member of groups[msg.groupId].members) updateLastChat(member, "group", msg.groupId, msg.text || "📷 Вложение"); return; }
        if (msg.type === "get_group_history") { if (groups[msg.groupId] && groups[msg.groupId].members.includes(ws.nick)) ws.send(JSON.stringify({ type: "group_history", groupId: msg.groupId, data: groups[msg.groupId].messages })); return; }
        if (msg.type === "get_my_groups") { ws.send(JSON.stringify({ type: "my_groups", groups: Object.values(groups).filter(g => g.members.includes(ws.nick)) })); return; }
        if (msg.type === "get_last_chats") { ws.send(JSON.stringify({ type: "last_chats", data: getLastChats(ws.nick) })); return; }
        if (msg.type === "get_group_info") { if (groups[msg.groupId]) ws.send(JSON.stringify({ type: "group_info", groupId: msg.groupId, group: groups[msg.groupId] })); return; }

        if (msg.type === "reaction") { updateReaction(msg.chatType, msg.id, ws.nick, msg.reaction, msg.remove); return; }

        if (msg.type === "edit") {
            let found = false;
            const m = history.find(x => x.id === msg.id);
            if (m && (m.owner === ws.nick || isDima(ws.nick))) { m.text = escapeHtml(msg.text.slice(0, 500)); savePublic(); broadcast({ type: "edit", id: msg.id, newText: m.text }); found = true; }
            if (!found) {
                for (const key in privateHistory) {
                    const idx = privateHistory[key].findIndex(x => x.id === msg.id);
                    if (idx !== -1 && (privateHistory[key][idx].owner === ws.nick || isDima(ws.nick))) {
                        privateHistory[key][idx].text = escapeHtml(msg.text.slice(0, 500)); savePrivate();
                        const otherNick = privateHistory[key][idx].from === ws.nick ? privateHistory[key][idx].to : privateHistory[key][idx].from;
                        let targetWs = null; for (const [c, nick] of usersOnline.entries()) if (nick === otherNick) { targetWs = c; break; }
                        if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "edit", id: msg.id, newText: privateHistory[key][idx].text }));
                        ws.send(JSON.stringify({ type: "edit", id: msg.id, newText: privateHistory[key][idx].text }));
                        break;
                    }
                }
            }
            return;
        }

        if (msg.type === "delete") {
            let found = false;
            const m = history.find(x => x.id === msg.id);
            if (m && (m.owner === ws.nick || isDima(ws.nick))) { history = history.filter(x => x.id !== msg.id); savePublic(); broadcast({ type: "delete", id: msg.id }); found = true; }
            if (!found) {
                for (const key in privateHistory) {
                    const idx = privateHistory[key].findIndex(x => x.id === msg.id);
                    if (idx !== -1 && (privateHistory[key][idx].owner === ws.nick || isDima(ws.nick))) {
                        const deleted = privateHistory[key][idx]; privateHistory[key].splice(idx, 1); savePrivate();
                        const otherNick = deleted.from === ws.nick ? deleted.to : deleted.from;
                        let targetWs = null; for (const [c, nick] of usersOnline.entries()) if (nick === otherNick) { targetWs = c; break; }
                        if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "delete", id: msg.id }));
                        ws.send(JSON.stringify({ type: "delete", id: msg.id }));
                        break;
                    }
                }
            }
            return;
        }

        if (msg.type === "get_private_history") {
            const key = getPrivateKey(ws.nick, msg.with);
            ws.send(JSON.stringify({ type: "private_history", with: msg.with, data: (privateHistory[key] || []).map(m => ({ ...m, timeFormatted: formatTime(m.time) })) }));
            return;
        }
        if (msg.type === "get_history") {
            ws.send(JSON.stringify({ type: "history", data: history.slice(-500).map(m => ({ ...m, timeFormatted: formatTime(m.time) })) }));
            return;
        }

        if (msg.type === "upload_file") {
            const filename = Date.now() + "_" + ws.nick + "_" + msg.filename;
            const filepath = path.join("files", filename);
            fs.writeFileSync(filepath, Buffer.from(msg.data, "base64"));
            ws.send(JSON.stringify({ type: "file_uploaded", url: `/files/${filename}`, filename: msg.filename }));
            return;
        }

        if (msg.type === "upload_music") {
            const filename = Date.now() + "_" + ws.nick + "_" + msg.filename;
            const filepath = path.join("music", filename);
            fs.writeFileSync(filepath, Buffer.from(msg.data, "base64"));
            ws.send(JSON.stringify({ type: "music_uploaded", url: `/music/${filename}`, filename: msg.filename }));
            return;
        }

        if (msg.type === "upload_voice") {
            const filename = Date.now() + "_" + ws.nick + ".webm";
            const filepath = path.join("voice", filename);
            fs.writeFileSync(filepath, Buffer.from(msg.data, "base64"));
            ws.send(JSON.stringify({ type: "voice_uploaded", url: `/voice/${filename}` }));
            return;
        }

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
            userStatus.set(ws.nick, { status: "offline", lastSeen: Date.now() });
            sendUsers();
            broadcast({ type: "system", text: `🔴 ${escapeHtml(ws.nick)} вышел` });
        }
        rate.delete(ws);
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
});