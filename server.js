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
app.use("/stickers", express.static("stickers"));

if (!fs.existsSync("files")) fs.mkdirSync("files");
if (!fs.existsSync("music")) fs.mkdirSync("music");
if (!fs.existsSync("voice")) fs.mkdirSync("voice");
if (!fs.existsSync("stickers")) fs.mkdirSync("stickers");

let history = [];
let privateHistory = {};
let groups = {};
let channels = {};
let usersOnline = new Map();
let userStatus = new Map();
let userLastSeen = new Map();
let sessions = new Map();
let rate = new Map();
let usersDB = {};
let userBlocks = new Map();
let userReputation = new Map();
let complaints = [];
let deviceTokens = {};

const DB_FILE = "db.json";
const PRIVATE_FILE = "private.json";
const GROUPS_FILE = "groups.json";
const CHANNELS_FILE = "channels.json";
const USERS_FILE = "users.json";
const SESSIONS_FILE = "sessions.json";
const COMPLAINTS_FILE = "complaints.json";
const REPUTATION_FILE = "reputation.json";
const DEVICES_FILE = "devices.json";

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

    try {
        if (fs.existsSync(CHANNELS_FILE)) {
            channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8")) || {};
            console.log(`✅ Загружено ${Object.keys(channels).length} каналов`);
        } else {
            channels = {};
            fs.writeFileSync(CHANNELS_FILE, JSON.stringify({}, null, 2));
        }
    } catch (e) { channels = {}; }

    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
            sessions = new Map(Object.entries(data));
            console.log(`✅ Загружено ${sessions.size} сессий`);
        } else {
            sessions = new Map();
            fs.writeFileSync(SESSIONS_FILE, JSON.stringify({}, null, 2));
        }
    } catch (e) { sessions = new Map(); }

    try {
        if (fs.existsSync(COMPLAINTS_FILE)) {
            complaints = JSON.parse(fs.readFileSync(COMPLAINTS_FILE, "utf8")) || [];
            console.log(`✅ Загружено ${complaints.length} жалоб`);
        } else {
            complaints = [];
            fs.writeFileSync(COMPLAINTS_FILE, JSON.stringify([], null, 2));
        }
    } catch (e) { complaints = []; }

    try {
        if (fs.existsSync(REPUTATION_FILE)) {
            userReputation = new Map(Object.entries(JSON.parse(fs.readFileSync(REPUTATION_FILE, "utf8"))));
            console.log(`✅ Загружена репутация для ${userReputation.size} пользователей`);
        } else {
            userReputation = new Map();
            fs.writeFileSync(REPUTATION_FILE, JSON.stringify({}, null, 2));
        }
    } catch (e) { userReputation = new Map(); }

    try {
        if (fs.existsSync(DEVICES_FILE)) {
            deviceTokens = JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8")) || {};
            console.log(`✅ Загружено ${Object.keys(deviceTokens).length} устройств`);
        } else {
            deviceTokens = {};
            fs.writeFileSync(DEVICES_FILE, JSON.stringify({}, null, 2));
        }
    } catch (e) { deviceTokens = {}; }
}

loadData();

function saveUsers() { try { fs.writeFileSync(USERS_FILE, JSON.stringify(usersDB, null, 2)); } catch(e){} }
function savePublic() { try { fs.writeFileSync(DB_FILE, JSON.stringify(history.slice(-500), null, 2)); } catch(e){} }
function savePrivate() { try { fs.writeFileSync(PRIVATE_FILE, JSON.stringify(privateHistory, null, 2)); } catch(e){} }
function saveGroups() { try { fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2)); } catch(e){} }
function saveChannels() { try { fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2)); } catch(e){} }
function saveSessions() { try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2)); } catch(e){} }
function saveComplaints() { try { fs.writeFileSync(COMPLAINTS_FILE, JSON.stringify(complaints, null, 2)); } catch(e){} }
function saveReputation() { try { fs.writeFileSync(REPUTATION_FILE, JSON.stringify(Object.fromEntries(userReputation), null, 2)); } catch(e){} }
function saveDevices() { try { fs.writeFileSync(DEVICES_FILE, JSON.stringify(deviceTokens, null, 2)); } catch(e){} }

function hashPassword(p) { return crypto.createHash("sha256").update(p).digest("hex"); }
function generateToken() { return crypto.randomBytes(32).toString("hex"); }
function generateDeviceId() { return crypto.randomBytes(16).toString("hex"); }
function formatTime(t) { const d = new Date(t); d.setHours(d.getHours() + 3); return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); }
function escapeHtml(s) { if (!s) return ""; return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function checkRate(ws) { const now = Date.now(); if (!rate.has(ws)) rate.set(ws, []); const arr = rate.get(ws).filter(t => now - t < 1000); arr.push(now); rate.set(ws, arr); return arr.length <= 10; }
function broadcast(obj) { const data = JSON.stringify(obj); for (const c of wss.clients) if (c.readyState === 1) c.send(data); }
function sendUsers() { broadcast({ type: "users", users: Array.from(usersOnline.values()), statuses: Object.fromEntries(userStatus), lastSeen: Object.fromEntries(userLastSeen), reputation: Object.fromEntries(userReputation) }); }
function validNick(n) { n = n?.trim(); if (!n || n.length < 2 || n.length > 16) return false; return /^[a-zA-Zа-яА-Я0-9_]+$/.test(n); }
function nickExistsInDB(n) { return !!usersDB[n]; }
function getPrivateKey(u1, u2) { return [u1, u2].sort().join("_"); }
function isBlocked(user, target) { return (userBlocks.get(user) || []).includes(target); }

function createChannel(name, creator) {
    const id = Date.now().toString() + "-" + Math.random().toString(36).substr(2, 6);
    channels[id] = { id, name: escapeHtml(name), creator, subscribers: [creator], messages: [], avatar: null, isLive: false, createdAt: Date.now() };
    saveChannels();
    return id;
}

function subscribeToChannel(channelId, nick) {
    if (!channels[channelId] || channels[channelId].subscribers.includes(nick)) return false;
    channels[channelId].subscribers.push(nick);
    saveChannels();
    for (const sub of channels[channelId].subscribers) {
        let targetWs = null;
        for (const [c, n] of usersOnline.entries()) if (n === sub) { targetWs = c; break; }
        if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "channel_update", channel: channels[channelId] }));
    }
    return true;
}

function sendChannelMessage(channelId, from, msgData) {
    if (!channels[channelId]) return;
    if (channels[channelId].creator !== from && from !== "Дима") return;
    const m = {
        id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
        from, text: escapeHtml((msgData.text || "").slice(0, 500)), image: msgData.image || null, video: msgData.video || null, file: msgData.file || null, music: msgData.music || null, voice: msgData.voice || null, sticker: msgData.sticker || null,
        time: Date.now(), timeFormatted: formatTime(Date.now()), reactions: {}, readBy: []
    };
    channels[channelId].messages.push(m);
    channels[channelId].messages = channels[channelId].messages.slice(-500);
    saveChannels();
    for (const sub of channels[channelId].subscribers) {
        let targetWs = null;
        for (const [c, n] of usersOnline.entries()) if (n === sub) { targetWs = c; break; }
        if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "channel_msg", channelId, data: m }));
    }
}

function createGroup(name, creator) {
    const id = Date.now().toString() + "-" + Math.random().toString(36).substr(2, 6);
    groups[id] = { id, name: escapeHtml(name), creator, members: [creator], messages: [], polls: [], avatar: null, createdAt: Date.now() };
    saveGroups();
    return id;
}

function addToGroup(groupId, nick) {
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
    if (groups[groupId].creator !== remover && remover !== "Дима") return false;
    if (nick === groups[groupId].creator && remover !== "Дима") return false;
    groups[groupId].members = groups[groupId].members.filter(m => m !== nick);
    saveGroups();
    for (const member of groups[groupId].members) {
        let targetWs = null;
        for (const [c, n] of usersOnline.entries()) if (n === member) { targetWs = c; break; }
        if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "group_update", group: groups[groupId] }));
    }
    return true;
}

function leaveGroup(groupId, nick) {
    if (!groups[groupId] || !groups[groupId].members.includes(nick)) return false;
    groups[groupId].members = groups[groupId].members.filter(m => m !== nick);
    saveGroups();
    for (const member of groups[groupId].members) {
        let targetWs = null;
        for (const [c, n] of usersOnline.entries()) if (n === member) { targetWs = c; break; }
        if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "group_update", group: groups[groupId] }));
    }
    return true;
}

function updateGroupAvatar(groupId, avatar, requester) {
    if (!groups[groupId] || (groups[groupId].creator !== requester && requester !== "Дима")) return false;
    groups[groupId].avatar = avatar;
    saveGroups();
    for (const member of groups[groupId].members) {
        let targetWs = null;
        for (const [c, n] of usersOnline.entries()) if (n === member) { targetWs = c; break; }
        if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "group_update", group: groups[groupId] }));
    }
    return true;
}

function updateGroupName(groupId, newName, requester) {
    if (!groups[groupId] || (groups[groupId].creator !== requester && requester !== "Дима")) return false;
    groups[groupId].name = escapeHtml(newName);
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
    const m = {
        id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
        from, text: escapeHtml((msgData.text || "").slice(0, 500)), image: msgData.image || null, video: msgData.video || null, file: msgData.file || null, music: msgData.music || null, voice: msgData.voice || null, sticker: msgData.sticker || null,
        time: Date.now(), timeFormatted: formatTime(Date.now()), reactions: {}, readBy: [from]
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

function addPollToGroup(groupId, poll, creator) {
    if (!groups[groupId] || !groups[groupId].members.includes(creator)) return false;
    groups[groupId].polls.push({ ...poll, id: Date.now().toString(), creator, votes: {} });
    saveGroups();
    for (const member of groups[groupId].members) {
        let targetWs = null;
        for (const [c, n] of usersOnline.entries()) if (n === member) { targetWs = c; break; }
        if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "poll_update", groupId, poll: groups[groupId].polls[groups[groupId].polls.length - 1] }));
    }
    return true;
}

function voteInPoll(groupId, pollId, option, voter) {
    if (!groups[groupId]) return false;
    const poll = groups[groupId].polls.find(p => p.id === pollId);
    if (!poll || poll.votes[voter]) return false;
    poll.votes[voter] = option;
    saveGroups();
    for (const member of groups[groupId].members) {
        let targetWs = null;
        for (const [c, n] of usersOnline.entries()) if (n === member) { targetWs = c; break; }
        if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "poll_update", groupId, poll }));
    }
    return true;
}

function changeReputation(nick, change) {
    const current = userReputation.get(nick) || 0;
    userReputation.set(nick, current + change);
    saveReputation();
    return userReputation.get(nick);
}

function addComplaint(from, to, reason) {
    const complaint = { id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 6), from, to, reason: escapeHtml(reason), time: Date.now(), resolved: false };
    complaints.push(complaint);
    saveComplaints();
    let dimaWs = null;
    for (const [c, nick] of usersOnline.entries()) { if (nick === "Дима") { dimaWs = c; break; } }
    if (dimaWs && dimaWs.readyState === 1) {
        dimaWs.send(JSON.stringify({ type: "new_complaint", complaint }));
    }
    return complaint;
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

function markAsRead(chatType, chatId, msgId, user) {
    let target = null;
    if (chatType === "public") target = history.find(x => x.id === msgId);
    else if (chatType === "private") { for (const key in privateHistory) { const idx = privateHistory[key].findIndex(x => x.id === msgId); if (idx !== -1) { target = privateHistory[key][idx]; break; } } }
    else if (chatType === "group" && groups[chatId]) { target = groups[chatId].messages.find(x => x.id === msgId); }
    else if (chatType === "channel" && channels[chatId]) { target = channels[chatId].messages.find(x => x.id === msgId); }
    if (target && !target.readBy?.includes(user)) {
        if (!target.readBy) target.readBy = [];
        target.readBy.push(user);
        if (chatType === "public") savePublic();
        else if (chatType === "private") savePrivate();
        else if (chatType === "group") saveGroups();
        else if (chatType === "channel") saveChannels();
        broadcast({ type: "read_update", chatType, chatId, msgId, readBy: target.readBy });
    }
}

function updateReaction(type, id, from, reaction, remove) {
    let target = null;
    if (type === "public") target = history.find(x => x.id === id);
    else if (type === "private") { for (const key in privateHistory) { const idx = privateHistory[key].findIndex(x => x.id === id); if (idx !== -1) { target = privateHistory[key][idx]; break; } } }
    else if (type === "group") { for (const gid in groups) { const idx = groups[gid].messages.findIndex(x => x.id === id); if (idx !== -1) { target = groups[gid].messages[idx]; break; } } }
    else if (type === "channel") { for (const cid in channels) { const idx = channels[cid].messages.findIndex(x => x.id === id); if (idx !== -1) { target = channels[cid].messages[idx]; break; } } }
    if (!target) return;
    if (!target.reactions) target.reactions = {};
    if (remove) delete target.reactions[from];
    else target.reactions[from] = reaction;
    if (type === "public") savePublic();
    else if (type === "private") savePrivate();
    else if (type === "group") saveGroups();
    else if (type === "channel") saveChannels();
    broadcast({ type: "reaction_update", id, from, reaction, remove });
}

wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => ws.isAlive = true);

    ws.send(JSON.stringify({ type: "history", data: history.slice(-500).map(m => ({ ...m, timeFormatted: formatTime(m.time) })) }));
    ws.send(JSON.stringify({ type: "users", users: Array.from(usersOnline.values()), statuses: Object.fromEntries(userStatus), lastSeen: Object.fromEntries(userLastSeen), reputation: Object.fromEntries(userReputation) }));

    ws.on("message", (raw) => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }

        if (msg.type === "auto_login") {
            const token = msg.token;
            const deviceId = msg.deviceId;
            let nick = sessions.get(token);
            if (!nick && deviceId && deviceTokens[deviceId]) {
                nick = deviceTokens[deviceId];
                const newToken = generateToken();
                sessions.set(newToken, nick);
                saveSessions();
                token = newToken;
            }
            if (nick && usersDB[nick]) {
                let alreadyOnline = false;
                for (const [c, n] of usersOnline.entries()) { if (n === nick) { alreadyOnline = true; break; } }
                if (alreadyOnline) { ws.send(JSON.stringify({ type: "error", text: "Уже в сети" })); return; }
                ws.nick = nick;
                usersOnline.set(ws, nick);
                userStatus.set(nick, { status: "online", lastSeen: Date.now() });
                userLastSeen.set(nick, Date.now());
                ws.send(JSON.stringify({ type: "login_success", nick: nick, profile: usersDB[nick].profile || {}, groups: Object.values(groups).filter(g => g.members.includes(nick)), channels: Object.values(channels).filter(c => c.subscribers.includes(nick)), lastChats: getLastChats(nick), isDima: nick === "Дима", reputation: userReputation.get(nick) || 0, token: token, deviceId: deviceId }));
                sendUsers();
                broadcast({ type: "system", text: `🟢 ${escapeHtml(nick)} вошёл` });
            } else { ws.send(JSON.stringify({ type: "error", text: "Сессия устарела, войдите заново" })); }
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
            const nick = msg.nick?.trim(); const password = msg.password?.trim(); const remember = msg.remember || false; const deviceId = msg.deviceId;
            if (!validNick(nick)) { ws.send(JSON.stringify({ type: "error", text: "Неверный ник" })); return; }
            if (!password) { ws.send(JSON.stringify({ type: "error", text: "Введите пароль" })); return; }
            if (!nickExistsInDB(nick)) { ws.send(JSON.stringify({ type: "error", text: "Пользователь не найден" })); return; }
            if (usersDB[nick].password !== hashPassword(password)) { ws.send(JSON.stringify({ type: "error", text: "Неверный пароль" })); return; }
            ws.nick = nick;
            usersOnline.set(ws, nick);
            userStatus.set(nick, { status: "online", lastSeen: Date.now() });
            userLastSeen.set(nick, Date.now());
            let token = null;
            let finalDeviceId = deviceId;
            if (remember) {
                token = generateToken();
                sessions.set(token, nick);
                saveSessions();
                if (!finalDeviceId) { finalDeviceId = generateDeviceId(); }
                deviceTokens[finalDeviceId] = nick;
                saveDevices();
            }
            ws.send(JSON.stringify({ type: "login_success", nick: nick, profile: usersDB[nick].profile || {}, token: token, deviceId: finalDeviceId, groups: Object.values(groups).filter(g => g.members.includes(nick)), channels: Object.values(channels).filter(c => c.subscribers.includes(nick)), lastChats: getLastChats(nick), isDima: nick === "Дима", reputation: userReputation.get(nick) || 0 }));
            sendUsers();
            broadcast({ type: "system", text: `🟢 ${escapeHtml(nick)} вошёл` });
            return;
        }

        if (!ws.nick) { ws.send(JSON.stringify({ type: "error", text: "Сначала войдите" })); return; }

        if (msg.type === "update_status") {
            userStatus.set(ws.nick, { status: msg.status, lastSeen: Date.now() });
            userLastSeen.set(ws.nick, Date.now());
            sendUsers();
            return;
        }

        if (msg.type === "get_profile") {
            if (usersDB[msg.nick]) {
                ws.send(JSON.stringify({ type: "profile_data", nick: msg.nick, profile: usersDB[msg.nick].profile || {}, reputation: userReputation.get(msg.nick) || 0 }));
            }
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

        if (msg.type === "change_reputation") {
            if (ws.nick !== "Дима") { ws.send(JSON.stringify({ type: "error", text: "Только администратор" })); return; }
            const newRep = changeReputation(msg.target, msg.change);
            sendUsers();
            broadcast({ type: "reputation_update", target: msg.target, reputation: newRep });
            ws.send(JSON.stringify({ type: "reputation_changed", target: msg.target, reputation: newRep }));
            return;
        }

        if (msg.type === "complaint") {
            if (!msg.target || !msg.reason) { ws.send(JSON.stringify({ type: "error", text: "Укажите пользователя и причину" })); return; }
            if (msg.target === ws.nick) { ws.send(JSON.stringify({ type: "error", text: "Нельзя жаловаться на себя" })); return; }
            const complaint = addComplaint(ws.nick, msg.target, msg.reason);
            ws.send(JSON.stringify({ type: "complaint_sent", complaint }));
            broadcast({ type: "system", text: `📩 ${ws.nick} пожаловался на ${msg.target}: ${msg.reason}` });
            return;
        }

        if (msg.type === "get_complaints") {
            if (ws.nick !== "Дима") { ws.send(JSON.stringify({ type: "error", text: "Только администратор" })); return; }
            ws.send(JSON.stringify({ type: "complaints_list", complaints }));
            return;
        }

        if (msg.type === "resolve_complaint") {
            if (ws.nick !== "Дима") { ws.send(JSON.stringify({ type: "error", text: "Только администратор" })); return; }
            const comp = complaints.find(c => c.id === msg.complaintId);
            if (comp) { comp.resolved = true; saveComplaints(); ws.send(JSON.stringify({ type: "complaint_resolved", complaintId: msg.complaintId })); }
            return;
        }

        if (msg.type === "create_channel") {
            const channelId = createChannel(msg.name, ws.nick);
            ws.send(JSON.stringify({ type: "channel_created", channel: channels[channelId] }));
            return;
        }

        if (msg.type === "subscribe_channel") {
            if (subscribeToChannel(msg.channelId, ws.nick)) {
                ws.send(JSON.stringify({ type: "channel_subscribed", channelId: msg.channelId }));
            }
            return;
        }

        if (msg.type === "channel_chat") {
            if (!checkRate(ws)) return;
            sendChannelMessage(msg.channelId, ws.nick, msg);
            return;
        }

        if (msg.type === "get_channel_history") {
            if (channels[msg.channelId] && channels[msg.channelId].subscribers.includes(ws.nick)) {
                ws.send(JSON.stringify({ type: "channel_history", channelId: msg.channelId, data: channels[msg.channelId].messages }));
            }
            return;
        }

        if (msg.type === "get_my_channels") {
            ws.send(JSON.stringify({ type: "my_channels", channels: Object.values(channels).filter(c => c.subscribers.includes(ws.nick)) }));
            return;
        }

        if (msg.type === "get_channel_info") {
            if (channels[msg.channelId]) {
                ws.send(JSON.stringify({ type: "channel_info", channelId: msg.channelId, channel: channels[msg.channelId] }));
            }
            return;
        }

        if (msg.type === "create_group") { const groupId = createGroup(msg.name, ws.nick); ws.send(JSON.stringify({ type: "group_created", group: groups[groupId] })); return; }
        if (msg.type === "invite_to_group") { if (addToGroup(msg.groupId, msg.nick)) ws.send(JSON.stringify({ type: "invite_sent", groupId: msg.groupId, nick: msg.nick })); return; }
        if (msg.type === "remove_from_group") { if (removeFromGroup(msg.groupId, msg.nick, ws.nick)) ws.send(JSON.stringify({ type: "remove_sent", groupId: msg.groupId, nick: msg.nick })); return; }
        if (msg.type === "leave_group") { if (leaveGroup(msg.groupId, ws.nick)) ws.send(JSON.stringify({ type: "leave_sent", groupId: msg.groupId })); return; }
        if (msg.type === "update_group_avatar") { if (updateGroupAvatar(msg.groupId, msg.avatar, ws.nick)) ws.send(JSON.stringify({ type: "group_avatar_updated", groupId: msg.groupId, avatar: msg.avatar })); return; }
        if (msg.type === "update_group_name") { if (updateGroupName(msg.groupId, msg.newName, ws.nick)) ws.send(JSON.stringify({ type: "group_name_updated", groupId: msg.groupId, newName: msg.newName })); return; }
        if (msg.type === "group_chat") { if (!checkRate(ws)) return; sendGroupMessage(msg.groupId, ws.nick, msg); for (const member of groups[msg.groupId].members) updateLastChat(member, "group", msg.groupId, msg.text || "📷 Вложение"); return; }
        if (msg.type === "get_group_history") { if (groups[msg.groupId] && groups[msg.groupId].members.includes(ws.nick)) ws.send(JSON.stringify({ type: "group_history", groupId: msg.groupId, data: groups[msg.groupId].messages })); return; }
        if (msg.type === "get_my_groups") { ws.send(JSON.stringify({ type: "my_groups", groups: Object.values(groups).filter(g => g.members.includes(ws.nick)) })); return; }
        if (msg.type === "get_last_chats") { ws.send(JSON.stringify({ type: "last_chats", data: getLastChats(ws.nick) })); return; }
        if (msg.type === "get_group_info") { if (groups[msg.groupId]) ws.send(JSON.stringify({ type: "group_info", groupId: msg.groupId, group: groups[msg.groupId] })); return; }

        if (msg.type === "create_poll") { addPollToGroup(msg.groupId, { question: msg.question, options: msg.options }, ws.nick); return; }
        if (msg.type === "vote_poll") { voteInPoll(msg.groupId, msg.pollId, msg.option, ws.nick); return; }

        if (msg.type === "mark_read") { markAsRead(msg.chatType, msg.chatId, msg.msgId, ws.nick); return; }
        if (msg.type === "reaction") { updateReaction(msg.chatType, msg.id, ws.nick, msg.reaction, msg.remove); return; }

        if (msg.type === "typing") {
            let targetWs = null;
            for (const [c, nick] of usersOnline.entries()) if (nick === msg.to) { targetWs = c; break; }
            if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "typing", from: ws.nick, isTyping: msg.isTyping }));
            return;
        }

        if (msg.type === "chat") {
            if (!checkRate(ws)) return;
            if (msg.text && msg.text.length > 500) { ws.send(JSON.stringify({ type: "error", text: "Сообщение слишком длинное" })); return; }
            const m = { id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8), text: escapeHtml((msg.text || "").slice(0, 500)), image: msg.image || null, video: msg.video || null, file: msg.file || null, music: msg.music || null, voice: msg.voice || null, sticker: msg.sticker || null, owner: ws.nick, time: Date.now(), timeFormatted: formatTime(Date.now()), reactions: {}, readBy: [ws.nick] };
            history.push(m); history = history.slice(-500); savePublic();
            updateLastChat(ws.nick, "public", "public", m.text || "📷 Вложение");
            broadcast({ type: "msg", data: m });
            return;
        }

        if (msg.type === "private_chat") {
            if (!checkRate(ws)) return;
            if (isBlocked(ws.nick, msg.target) || isBlocked(msg.target, ws.nick)) {
                ws.send(JSON.stringify({ type: "error", text: "Пользователь заблокирован" }));
                return;
            }
            if (msg.text && msg.text.length > 500) { ws.send(JSON.stringify({ type: "error", text: "Сообщение слишком длинное" })); return; }
            const key = getPrivateKey(ws.nick, msg.target);
            if (!privateHistory[key]) privateHistory[key] = [];
            const m = { id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8), from: ws.nick, to: msg.target, text: escapeHtml((msg.text || "").slice(0, 500)), image: msg.image || null, video: msg.video || null, file: msg.file || null, music: msg.music || null, voice: msg.voice || null, sticker: msg.sticker || null, owner: ws.nick, time: Date.now(), timeFormatted: formatTime(Date.now()), reactions: {}, readBy: [ws.nick] };
            privateHistory[key].push(m); privateHistory[key] = privateHistory[key].slice(-500); savePrivate();
            updateLastChat(ws.nick, "private", msg.target, m.text || "📷 Вложение");
            updateLastChat(msg.target, "private", ws.nick, m.text || "📷 Вложение");
            ws.send(JSON.stringify({ type: "private_msg", data: m, with: msg.target }));
            let targetWs = null;
            for (const [c, nick] of usersOnline.entries()) if (nick === msg.target) { targetWs = c; break; }
            if (targetWs && targetWs.readyState === 1) targetWs.send(JSON.stringify({ type: "private_msg", data: m, with: ws.nick }));
            return;
        }

        if (msg.type === "block_user") {
            if (!userBlocks.has(ws.nick)) userBlocks.set(ws.nick, []);
            if (!userBlocks.get(ws.nick).includes(msg.target)) {
                userBlocks.get(ws.nick).push(msg.target);
                ws.send(JSON.stringify({ type: "block_success", target: msg.target }));
            }
            return;
        }

        if (msg.type === "unblock_user") {
            if (userBlocks.has(ws.nick)) {
                userBlocks.set(ws.nick, userBlocks.get(ws.nick).filter(b => b !== msg.target));
                ws.send(JSON.stringify({ type: "unblock_success", target: msg.target }));
            }
            return;
        }

        if (msg.type === "edit") {
            let found = false;
            const m = history.find(x => x.id === msg.id);
            if (m && (m.owner === ws.nick || ws.nick === "Дима")) {
                if (msg.text && msg.text.length > 500) { ws.send(JSON.stringify({ type: "error", text: "Сообщение слишком длинное" })); return; }
                m.text = escapeHtml(msg.text.slice(0, 500));
                savePublic();
                broadcast({ type: "edit", id: msg.id, newText: m.text });
                found = true;
            }
            if (!found) {
                for (const key in privateHistory) {
                    const idx = privateHistory[key].findIndex(x => x.id === msg.id);
                    if (idx !== -1 && (privateHistory[key][idx].owner === ws.nick || ws.nick === "Дима")) {
                        if (msg.text && msg.text.length > 500) { ws.send(JSON.stringify({ type: "error", text: "Сообщение слишком длинное" })); return; }
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

        if (msg.type === "delete") {
            let found = false;
            const m = history.find(x => x.id === msg.id);
            if (m && (m.owner === ws.nick || ws.nick === "Дима")) {
                history = history.filter(x => x.id !== msg.id);
                savePublic();
                broadcast({ type: "delete", id: msg.id });
                found = true;
            }
            if (!found) {
                for (const key in privateHistory) {
                    const idx = privateHistory[key].findIndex(x => x.id === msg.id);
                    if (idx !== -1 && (privateHistory[key][idx].owner === ws.nick || ws.nick === "Дима")) {
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
            if (msg.data && msg.data.length > 10 * 1024 * 1024) { ws.send(JSON.stringify({ type: "error", text: "Файл слишком большой (макс 10MB)" })); return; }
            const filename = Date.now() + "_" + ws.nick + "_" + msg.filename;
            const filepath = path.join("files", filename);
            try { fs.writeFileSync(filepath, Buffer.from(msg.data, "base64")); ws.send(JSON.stringify({ type: "file_uploaded", url: `/files/${filename}`, filename: msg.filename })); } catch(e) { ws.send(JSON.stringify({ type: "error", text: "Ошибка сохранения файла" })); }
            return;
        }

        if (msg.type === "upload_music") {
            if (msg.data && msg.data.length > 10 * 1024 * 1024) { ws.send(JSON.stringify({ type: "error", text: "Файл слишком большой (макс 10MB)" })); return; }
            const filename = Date.now() + "_" + ws.nick + "_" + msg.filename;
            const filepath = path.join("music", filename);
            try { fs.writeFileSync(filepath, Buffer.from(msg.data, "base64")); ws.send(JSON.stringify({ type: "music_uploaded", url: `/music/${filename}`, filename: msg.filename })); } catch(e) { ws.send(JSON.stringify({ type: "error", text: "Ошибка сохранения файла" })); }
            return;
        }

        if (msg.type === "upload_voice") {
            if (msg.data && msg.data.length > 5 * 1024 * 1024) { ws.send(JSON.stringify({ type: "error", text: "Голосовое слишком большое (макс 5MB)" })); return; }
            const filename = Date.now() + "_" + ws.nick + ".webm";
            const filepath = path.join("voice", filename);
            try { fs.writeFileSync(filepath, Buffer.from(msg.data, "base64")); ws.send(JSON.stringify({ type: "voice_uploaded", url: `/voice/${filename}` })); } catch(e) { ws.send(JSON.stringify({ type: "error", text: "Ошибка сохранения голосового" })); }
            return;
        }

        if (msg.type === "upload_sticker") {
            if (msg.data && msg.data.length > 1 * 1024 * 1024) { ws.send(JSON.stringify({ type: "error", text: "Стикер слишком большой (макс 1MB)" })); return; }
            const filename = Date.now() + "_" + ws.nick + ".png";
            const filepath = path.join("stickers", filename);
            try { fs.writeFileSync(filepath, Buffer.from(msg.data, "base64")); ws.send(JSON.stringify({ type: "sticker_uploaded", url: `/stickers/${filename}` })); } catch(e) { ws.send(JSON.stringify({ type: "error", text: "Ошибка сохранения стикера" })); }
            return;
        }

        if (msg.type === "add_sticker") {
            if (!usersDB[ws.nick].stickers) usersDB[ws.nick].stickers = [];
            usersDB[ws.nick].stickers.push(msg.url);
            saveUsers();
            return;
        }

        if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice") {
            let targetWs = null;
            for (const [c, nick] of usersOnline.entries()) if (nick === msg.to) { targetWs = c; break; }
            if (targetWs && targetWs.readyState === 1) {
                targetWs.send(JSON.stringify({ type: msg.type, from: ws.nick, offer: msg.offer, answer: msg.answer, ice: msg.ice, video: msg.video || false }));
            }
            return;
        }
    });

    ws.on("close", () => {
        if (ws.nick) {
            usersOnline.delete(ws);
            userStatus.set(ws.nick, { status: "offline", lastSeen: Date.now() });
            userLastSeen.set(ws.nick, Date.now());
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