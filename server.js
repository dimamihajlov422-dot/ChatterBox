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
app.use("/images", express.static("images"));

// ===== ПАПКИ =====
const dirs = ["files", "music", "voice", "stickers", "images", "public"];
dirs.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

// ===== ПЕРЕМЕННЫЕ =====
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
let pinnedMessages = [];
let scheduledMessages = [];
let ipAttempts = new Map(); // Для защиты от брутфорса
let ipBlockedUntil = new Map(); // Блокировка IP

// ===== ФАЙЛЫ =====
const DB_FILE = "db.json";
const PRIVATE_FILE = "private.json";
const GROUPS_FILE = "groups.json";
const CHANNELS_FILE = "channels.json";
const USERS_FILE = "users.json";
const SESSIONS_FILE = "sessions.json";
const COMPLAINTS_FILE = "complaints.json";
const REPUTATION_FILE = "reputation.json";
const DEVICES_FILE = "devices.json";
const PINNED_FILE = "pinned.json";
const SCHEDULED_FILE = "scheduled.json";

// ============================================================
// ЗАГРУЗКА ДАННЫХ
// ============================================================

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

    try {
        if (fs.existsSync(PINNED_FILE)) {
            pinnedMessages = JSON.parse(fs.readFileSync(PINNED_FILE, "utf8")) || [];
            console.log(`✅ Загружено ${pinnedMessages.length} закреплённых сообщений`);
        } else {
            pinnedMessages = [];
            fs.writeFileSync(PINNED_FILE, JSON.stringify([], null, 2));
        }
    } catch (e) { pinnedMessages = []; }

    try {
        if (fs.existsSync(SCHEDULED_FILE)) {
            scheduledMessages = JSON.parse(fs.readFileSync(SCHEDULED_FILE, "utf8")) || [];
            console.log(`✅ Загружено ${scheduledMessages.length} запланированных сообщений`);
        } else {
            scheduledMessages = [];
            fs.writeFileSync(SCHEDULED_FILE, JSON.stringify([], null, 2));
        }
    } catch (e) { scheduledMessages = []; }
}

loadData();

// ============================================================
// СОХРАНЕНИЕ
// ============================================================

function saveUsers() { try { fs.writeFileSync(USERS_FILE, JSON.stringify(usersDB, null, 2)); } catch(e){} }
function savePublic() { try { fs.writeFileSync(DB_FILE, JSON.stringify(history.slice(-500), null, 2)); } catch(e){} }
function savePrivate() { try { fs.writeFileSync(PRIVATE_FILE, JSON.stringify(privateHistory, null, 2)); } catch(e){} }
function saveGroups() { try { fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2)); } catch(e){} }
function saveChannels() { try { fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2)); } catch(e){} }
function saveSessions() { try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2)); } catch(e){} }
function saveComplaints() { try { fs.writeFileSync(COMPLAINTS_FILE, JSON.stringify(complaints, null, 2)); } catch(e){} }
function saveReputation() { try { fs.writeFileSync(REPUTATION_FILE, JSON.stringify(Object.fromEntries(userReputation), null, 2)); } catch(e){} }
function saveDevices() { try { fs.writeFileSync(DEVICES_FILE, JSON.stringify(deviceTokens, null, 2)); } catch(e){} }
function savePinned() { try { fs.writeFileSync(PINNED_FILE, JSON.stringify(pinnedMessages, null, 2)); } catch(e){} }
function saveScheduled() { try { fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(scheduledMessages, null, 2)); } catch(e){} }

// ============================================================
// УТИЛИТЫ
// ============================================================

function hashPassword(p) { return crypto.createHash("sha256").update(p).digest("hex"); }
function generateToken() { return crypto.randomBytes(32).toString("hex"); }
function generateDeviceId() { return crypto.randomBytes(16).toString("hex"); }
function formatTime(t) { const d = new Date(t); d.setHours(d.getHours() + 3); return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); }
function formatFullTime(t) { const d = new Date(t); d.setHours(d.getHours() + 3); return d.toLocaleString("ru-RU"); }
function escapeHtml(s) { if (!s) return ""; return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function validNick(n) { n = n?.trim(); if (!n || n.length < 2 || n.length > 16) return false; return /^[a-zA-Zа-яА-Я0-9_]+$/.test(n); }
function nickExistsInDB(n) { return !!usersDB[n]; }
function getPrivateKey(u1, u2) { return [u1, u2].sort().join("_"); }
function isBlocked(user, target) { return (userBlocks.get(user) || []).includes(target); }
function sendToUser(nick, obj) {
    for (const [c, n] of usersOnline.entries()) {
        if (n === nick && c.readyState === 1) {
            c.send(JSON.stringify(obj));
            return true;
        }
    }
    return false;
}

function broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const c of wss.clients) {
        if (c.readyState === 1) c.send(data);
    }
}

function sendUsers() {
    broadcast({ 
        type: "users", 
        users: Array.from(usersOnline.values()), 
        statuses: Object.fromEntries(userStatus), 
        lastSeen: Object.fromEntries(userLastSeen), 
        reputation: Object.fromEntries(userReputation) 
    });
}

function checkRate(ws) {
    const now = Date.now();
    if (!rate.has(ws)) rate.set(ws, []);
    const arr = rate.get(ws).filter(t => now - t < 1000);
    arr.push(now);
    rate.set(ws, arr);
    return arr.length <= 10;
}

// ============================================================
// ЗАЩИТА ОТ БРУТФОРСА (5 попыток → 5 минут блокировки)
// ============================================================

function checkIPBlock(ip) {
    if (ipBlockedUntil.has(ip)) {
        if (Date.now() < ipBlockedUntil.get(ip)) {
            return true; // Заблокирован
        } else {
            ipBlockedUntil.delete(ip);
            ipAttempts.delete(ip);
        }
    }
    return false;
}

function recordIPAttempt(ip) {
    if (!ipAttempts.has(ip)) ipAttempts.set(ip, 0);
    ipAttempts.set(ip, ipAttempts.get(ip) + 1);
    if (ipAttempts.get(ip) >= 5) {
        ipBlockedUntil.set(ip, Date.now() + 5 * 60 * 1000); // 5 минут
        console.log(`🚫 IP ${ip} заблокирован на 5 минут за превышение попыток`);
        return true;
    }
    return false;
}

function resetIPAttempts(ip) {
    ipAttempts.delete(ip);
    ipBlockedUntil.delete(ip);
}

// ============================================================
// КАНАЛЫ
// ============================================================

function createChannel(name, creator) {
    if (creator !== "Дима") return null;
    const id = Date.now().toString() + "-" + Math.random().toString(36).substr(2, 6);
    channels[id] = {
        id,
        name: escapeHtml(name),
        creator,
        subscribers: [],
        messages: [],
        avatar: null,
        isLive: false,
        createdAt: Date.now(),
        description: ""
    };
    saveChannels();
    console.log(`📣 Канал "${name}" создан`);
    return id;
}

function subscribeToChannel(channelId, nick) {
    if (!channels[channelId] || channels[channelId].subscribers.includes(nick)) return false;
    channels[channelId].subscribers.push(nick);
    saveChannels();
    broadcast({ type: "channel_update", channel: channels[channelId] });
    return true;
}

function sendChannelMessage(channelId, from, msgData) {
    if (!channels[channelId]) return;
    if (channels[channelId].creator !== from) return;
    const m = {
        id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
        from,
        text: escapeHtml((msgData.text || "").slice(0, 500)),
        image: msgData.image || null,
        video: msgData.video || null,
        circle: msgData.circle || null,
        file: msgData.file || null,
        music: msgData.music || null,
        voice: msgData.voice || null,
        sticker: msgData.sticker || null,
        location: msgData.location || null,
        time: Date.now(),
        timeFormatted: formatTime(Date.now()),
        reactions: {},
        readBy: [],
        chatId: `channel_${channelId}`
    };
    channels[channelId].messages.push(m);
    if (channels[channelId].messages.length > 500) {
        channels[channelId].messages = channels[channelId].messages.slice(-500);
    }
    saveChannels();
    for (const sub of channels[channelId].subscribers) {
        sendToUser(sub, { type: "channel_msg", channelId, data: m });
    }
}

function getChannelsForUser(nick) {
    return Object.values(channels);
}

// ============================================================
// ГРУППЫ
// ============================================================

function createGroup(name, creator) {
    const id = Date.now().toString() + "-" + Math.random().toString(36).substr(2, 6);
    groups[id] = {
        id,
        name: escapeHtml(name),
        creator,
        members: [creator],
        admins: [creator],
        messages: [],
        polls: [],
        avatar: null,
        createdAt: Date.now(),
        description: ""
    };
    saveGroups();
    return id;
}

function addToGroup(groupId, nick) {
    if (!groups[groupId] || groups[groupId].members.includes(nick)) return false;
    groups[groupId].members.push(nick);
    saveGroups();
    broadcast({ type: "group_update", group: groups[groupId] });
    return true;
}

function sendGroupMessage(groupId, from, msgData) {
    if (!groups[groupId]) return;
    if (!groups[groupId].members.includes(from)) return;
    const m = {
        id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
        from,
        text: escapeHtml((msgData.text || "").slice(0, 500)),
        image: msgData.image || null,
        video: msgData.video || null,
        circle: msgData.circle || null,
        file: msgData.file || null,
        music: msgData.music || null,
        voice: msgData.voice || null,
        sticker: msgData.sticker || null,
        location: msgData.location || null,
        time: Date.now(),
        timeFormatted: formatTime(Date.now()),
        reactions: {},
        readBy: [from],
        chatId: `group_${groupId}`
    };
    groups[groupId].messages.push(m);
    if (groups[groupId].messages.length > 500) {
        groups[groupId].messages = groups[groupId].messages.slice(-500);
    }
    saveGroups();
    for (const member of groups[groupId].members) {
        sendToUser(member, { type: "group_msg", groupId, data: m });
        updateLastChat(member, "group", groupId, m.text || "📎 Вложение");
    }
}

function addPollToGroup(groupId, poll, creator) {
    if (!groups[groupId] || !groups[groupId].members.includes(creator)) return false;
    const newPoll = {
        id: Date.now().toString(),
        question: escapeHtml(poll.question.slice(0, 200)),
        options: poll.options.map(o => escapeHtml(o.slice(0, 100))),
        creator,
        createdAt: Date.now(),
        votes: {},
        isActive: true
    };
    groups[groupId].polls.push(newPoll);
    saveGroups();
    broadcast({ type: "poll_update", groupId, poll: newPoll });
    return true;
}

function voteInPoll(groupId, pollId, option, voter) {
    if (!groups[groupId]) return false;
    const poll = groups[groupId].polls.find(p => p.id === pollId);
    if (!poll || !poll.isActive) return false;
    if (!poll.options.includes(option)) return false;
    if (poll.votes[voter]) return false;
    poll.votes[voter] = option;
    saveGroups();
    broadcast({ type: "poll_update", groupId, poll });
    return true;
}

// ============================================================
// ЗАКРЕПЛЁННЫЕ СООБЩЕНИЯ
// ============================================================

function pinMessage(chatId, msgId, user) {
    // Ищем сообщение во всех хранилищах
    let target = null;
    let source = null;
    
    // Поиск в публичных
    target = history.find(m => m.id === msgId);
    if (target) source = "public";
    
    // Поиск в приватных
    if (!target) {
        for (const key in privateHistory) {
            const found = privateHistory[key].find(m => m.id === msgId);
            if (found) { target = found; source = "private"; break; }
        }
    }
    
    // Поиск в группах
    if (!target) {
        for (const gid in groups) {
            const found = groups[gid].messages.find(m => m.id === msgId);
            if (found) { target = found; source = `group_${gid}`; break; }
        }
    }
    
    // Поиск в каналах
    if (!target) {
        for (const cid in channels) {
            const found = channels[cid].messages.find(m => m.id === msgId);
            if (found) { target = found; source = `channel_${cid}`; break; }
        }
    }
    
    if (!target) return false;
    if (target.owner !== user && target.from !== user && user !== "Дима") return false;
    
    // Проверяем, не закреплено ли уже
    if (pinnedMessages.find(m => m.id === msgId)) return false;
    
    const pinned = {
        ...target,
        chatId: chatId,
        pinnedBy: user,
        pinnedAt: Date.now()
    };
    pinnedMessages.push(pinned);
    savePinned();
    broadcast({ type: "pinned_updated", message: pinned });
    return true;
}

function unpinMessage(msgId, user) {
    const index = pinnedMessages.findIndex(m => m.id === msgId);
    if (index === -1) return false;
    if (pinnedMessages[index].owner !== user && pinnedMessages[index].from !== user && user !== "Дима") return false;
    pinnedMessages.splice(index, 1);
    savePinned();
    broadcast({ type: "pinned_updated", unpinId: msgId });
    return true;
}

function getPinnedMessages(chatId) {
    return pinnedMessages.filter(m => m.chatId === chatId);
}

// ============================================================
// ПЛАНИРОВЩИК СООБЩЕНИЙ
// ============================================================

function scheduleMessage(chatId, text, scheduledTime, from) {
    const msg = {
        id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
        chatId: chatId,
        text: escapeHtml(text.slice(0, 500)),
        from: from,
        scheduledTime: scheduledTime,
        createdAt: Date.now(),
        sent: false
    };
    scheduledMessages.push(msg);
    saveScheduled();
    return msg;
}

function checkScheduledMessages() {
    const now = Date.now();
    let sent = 0;
    for (const msg of scheduledMessages) {
        if (!msg.sent && msg.scheduledTime <= now) {
            // Отправляем сообщение
            const chatId = msg.chatId;
            const from = msg.from;
            const text = msg.text;
            
            // Определяем тип чата и отправляем
            if (chatId === "public") {
                const m = {
                    id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
                    text: text,
                    owner: from,
                    time: Date.now(),
                    timeFormatted: formatTime(Date.now()),
                    reactions: {},
                    readBy: [from],
                    chatId: "public"
                };
                history.push(m);
                if (history.length > 500) history = history.slice(-500);
                savePublic();
                broadcast({ type: "msg", data: m });
            } else if (chatId.startsWith("private_")) {
                const target = chatId.replace("private_", "");
                const key = getPrivateKey(from, target);
                if (!privateHistory[key]) privateHistory[key] = [];
                const m = {
                    id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
                    from: from,
                    to: target,
                    text: text,
                    time: Date.now(),
                    timeFormatted: formatTime(Date.now()),
                    reactions: {},
                    readBy: [from],
                    chatId: chatId
                };
                privateHistory[key].push(m);
                if (privateHistory[key].length > 500) privateHistory[key] = privateHistory[key].slice(-500);
                savePrivate();
                sendToUser(from, { type: "private_msg", data: m, with: target });
                sendToUser(target, { type: "private_msg", data: m, with: from });
            } else if (chatId.startsWith("group_")) {
                const gid = chatId.replace("group_", "");
                if (groups[gid]) {
                    const m = {
                        id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
                        from: from,
                        text: text,
                        time: Date.now(),
                        timeFormatted: formatTime(Date.now()),
                        reactions: {},
                        readBy: [from],
                        chatId: chatId
                    };
                    groups[gid].messages.push(m);
                    if (groups[gid].messages.length > 500) groups[gid].messages = groups[gid].messages.slice(-500);
                    saveGroups();
                    for (const member of groups[gid].members) {
                        sendToUser(member, { type: "group_msg", groupId: gid, data: m });
                    }
                }
            } else if (chatId.startsWith("channel_")) {
                const cid = chatId.replace("channel_", "");
                if (channels[cid] && channels[cid].creator === from) {
                    const m = {
                        id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
                        from: from,
                        text: text,
                        time: Date.now(),
                        timeFormatted: formatTime(Date.now()),
                        reactions: {},
                        readBy: [],
                        chatId: chatId
                    };
                    channels[cid].messages.push(m);
                    if (channels[cid].messages.length > 500) channels[cid].messages = channels[cid].messages.slice(-500);
                    saveChannels();
                    for (const sub of channels[cid].subscribers) {
                        sendToUser(sub, { type: "channel_msg", channelId: cid, data: m });
                    }
                }
            }
            
            msg.sent = true;
            sent++;
        }
    }
    if (sent > 0) {
        saveScheduled();
        // Удаляем отправленные
        scheduledMessages = scheduledMessages.filter(m => !m.sent);
        saveScheduled();
    }
}

// Проверка запланированных сообщений каждые 10 секунд
setInterval(checkScheduledMessages, 10000);

// ============================================================
// ПЕРЕВОД (заглушка для демонстрации)
// ============================================================

function translateText(text, targetLang) {
    // Простая заглушка для демонстрации
    const translations = {
        ru: {
            "hello": "привет",
            "how are you": "как дела",
            "good morning": "доброе утро",
            "good night": "спокойной ночи",
            "thank you": "спасибо",
            "yes": "да",
            "no": "нет",
            "maybe": "возможно",
            "ok": "хорошо",
            "help": "помощь"
        },
        en: {
            "привет": "hello",
            "как дела": "how are you",
            "доброе утро": "good morning",
            "спокойной ночи": "good night",
            "спасибо": "thank you",
            "да": "yes",
            "нет": "no",
            "возможно": "maybe",
            "хорошо": "ok",
            "помощь": "help"
        },
        zh: {
            "привет": "你好",
            "как дела": "你好吗",
            "спасибо": "谢谢",
            "да": "是",
            "нет": "不是",
            "хорошо": "好",
            "помощь": "帮助"
        }
    };
    
    const lower = text.toLowerCase();
    const langMap = translations[targetLang] || translations.ru;
    
    // Простой поиск по словарю
    let result = text;
    for (const [key, value] of Object.entries(langMap)) {
        if (lower.includes(key)) {
            result = result.replace(new RegExp(key, "gi"), value);
        }
    }
    
    // Если ничего не найдено, возвращаем оригинал с пометкой
    if (result === text) {
        return `[Перевод на ${targetLang}] ${text}`;
    }
    return result;
}

// ============================================================
// ЧАТЫ
// ============================================================

function updateLastChat(nick, chatType, chatId, lastMessage) {
    if (!usersDB[nick]) usersDB[nick] = {};
    if (!usersDB[nick].lastChats) usersDB[nick].lastChats = [];
    const existing = usersDB[nick].lastChats.find(c => c.chatId === chatId);
    if (existing) {
        existing.lastMessage = lastMessage;
        existing.timestamp = Date.now();
    } else {
        usersDB[nick].lastChats.unshift({ chatType, chatId, lastMessage, timestamp: Date.now() });
    }
    usersDB[nick].lastChats = usersDB[nick].lastChats.slice(0, 20);
    saveUsers();
}

function getLastChats(nick) {
    return (usersDB[nick]?.lastChats || []).sort((a, b) => b.timestamp - a.timestamp);
}

function markAsRead(chatType, chatId, msgId, user) {
    let target = null;
    if (chatType === "public") target = history.find(x => x.id === msgId);
    else if (chatType === "private") {
        for (const key in privateHistory) {
            const idx = privateHistory[key].findIndex(x => x.id === msgId);
            if (idx !== -1) { target = privateHistory[key][idx]; break; }
        }
    } else if (chatType === "group" && groups[chatId]) {
        target = groups[chatId].messages.find(x => x.id === msgId);
    } else if (chatType === "channel" && channels[chatId]) {
        target = channels[chatId].messages.find(x => x.id === msgId);
    }
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
    else if (type === "private") {
        for (const key in privateHistory) {
            const idx = privateHistory[key].findIndex(x => x.id === id);
            if (idx !== -1) { target = privateHistory[key][idx]; break; }
        }
    } else if (type === "group") {
        for (const gid in groups) {
            const idx = groups[gid].messages.findIndex(x => x.id === id);
            if (idx !== -1) { target = groups[gid].messages[idx]; break; }
        }
    } else if (type === "channel") {
        for (const cid in channels) {
            const idx = channels[cid].messages.findIndex(x => x.id === id);
            if (idx !== -1) { target = channels[cid].messages[idx]; break; }
        }
    }
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

function editMessage(chatType, chatId, msgId, newText, editor) {
    let target = null;
    let targetArray = null;
    
    if (chatType === "public") {
        target = history.find(x => x.id === msgId);
        targetArray = history;
    } else if (chatType === "private") {
        for (const key in privateHistory) {
            const idx = privateHistory[key].findIndex(x => x.id === msgId);
            if (idx !== -1) {
                target = privateHistory[key][idx];
                targetArray = privateHistory[key];
                break;
            }
        }
    } else if (chatType === "group" && groups[chatId]) {
        target = groups[chatId].messages.find(x => x.id === msgId);
        targetArray = groups[chatId].messages;
    } else if (chatType === "channel" && channels[chatId]) {
        target = channels[chatId].messages.find(x => x.id === msgId);
        targetArray = channels[chatId].messages;
    }
    
    if (!target) return false;
    if (target.owner !== editor && target.from !== editor && editor !== "Дима") return false;
    
    target.text = escapeHtml(newText.slice(0, 500));
    target.edited = true;
    
    if (chatType === "public") savePublic();
    else if (chatType === "private") savePrivate();
    else if (chatType === "group") saveGroups();
    else if (chatType === "channel") saveChannels();
    
    broadcast({ type: "edit", id: msgId, newText: target.text });
    return true;
}

function deleteMessage(chatType, chatId, msgId, deleter) {
    let target = null;
    let targetArray = null;
    if (chatType === "public") {
        target = history.find(x => x.id === msgId);
        targetArray = history;
    } else if (chatType === "private") {
        for (const key in privateHistory) {
            const idx = privateHistory[key].findIndex(x => x.id === msgId);
            if (idx !== -1) {
                target = privateHistory[key][idx];
                targetArray = privateHistory[key];
                break;
            }
        }
    } else if (chatType === "group" && groups[chatId]) {
        target = groups[chatId].messages.find(x => x.id === msgId);
        targetArray = groups[chatId].messages;
    } else if (chatType === "channel" && channels[chatId]) {
        target = channels[chatId].messages.find(x => x.id === msgId);
        targetArray = channels[chatId].messages;
    }
    if (!target) return false;
    if (target.owner !== deleter && target.from !== deleter && deleter !== "Дима") return false;
    const index = targetArray.indexOf(target);
    if (index !== -1) {
        targetArray.splice(index, 1);
        if (chatType === "public") savePublic();
        else if (chatType === "private") savePrivate();
        else if (chatType === "group") saveGroups();
        else if (chatType === "channel") saveChannels();
        broadcast({ type: "delete", id: msgId });
        return true;
    }
    return false;
}

// ============================================================
// ЗАГРУЗКА ФАЙЛОВ
// ============================================================

function handleUpload(ws, msg, folder, type) {
    if (msg.data && msg.data.length > 10 * 1024 * 1024) {
        ws.send(JSON.stringify({ type: "error", text: "Файл слишком большой (макс 10MB)" }));
        return;
    }
    const filename = Date.now() + "_" + ws.nick + "_" + (msg.filename || "video.webm");
    const filepath = path.join(folder, filename);
    try {
        fs.writeFileSync(filepath, Buffer.from(msg.data, "base64"));
        ws.send(JSON.stringify({ type: type, url: `/${folder}/${filename}`, filename: msg.filename || filename }));
    } catch(e) {
        ws.send(JSON.stringify({ type: "error", text: "Ошибка сохранения файла" }));
    }
}

// ============================================================
// ВЕБСОКЕТ
// ============================================================

wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => ws.isAlive = true);
    
    // Получаем IP для защиты от брутфорса
    const ip = ws._socket.remoteAddress || "unknown";

    ws.send(JSON.stringify({
        type: "history",
        data: history.slice(-500).map(m => ({ ...m, timeFormatted: formatTime(m.time) }))
    }));
    ws.send(JSON.stringify({
        type: "users",
        users: Array.from(usersOnline.values()),
        statuses: Object.fromEntries(userStatus),
        lastSeen: Object.fromEntries(userLastSeen),
        reputation: Object.fromEntries(userReputation)
    }));
    
    // Отправляем закреплённые сообщения
    ws.send(JSON.stringify({
        type: "pinned_messages",
        messages: pinnedMessages
    }));

    ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        // ===== АВТОВХОД =====
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
                for (const [c, n] of usersOnline.entries()) {
                    if (n === nick) { alreadyOnline = true; break; }
                }
                if (alreadyOnline) {
                    ws.send(JSON.stringify({ type: "error", text: "Уже в сети" }));
                    return;
                }
                ws.nick = nick;
                usersOnline.set(ws, nick);
                userStatus.set(nick, { status: "online", lastSeen: Date.now() });
                userLastSeen.set(nick, Date.now());
                ws.send(JSON.stringify({
                    type: "login_success",
                    nick: nick,
                    profile: usersDB[nick].profile || {},
                    groups: Object.values(groups).filter(g => g.members.includes(nick)),
                    channels: getChannelsForUser(nick),
                    lastChats: getLastChats(nick),
                    isDima: nick === "Дима",
                    reputation: userReputation.get(nick) || 0,
                    token: token,
                    deviceId: deviceId
                }));
                sendUsers();
                resetIPAttempts(ip);
            } else {
                ws.send(JSON.stringify({ type: "error", text: "Сессия устарела, войдите заново" }));
            }
            return;
        }

        // ===== РЕГИСТРАЦИЯ =====
        if (msg.type === "register") {
            // Проверка на блокировку IP
            if (checkIPBlock(ip)) {
                ws.send(JSON.stringify({ type: "error", text: "Слишком много попыток. Подождите 5 минут." }));
                return;
            }
            
            const nick = msg.nick?.trim();
            const password = msg.password?.trim();
            if (!validNick(nick)) {
                ws.send(JSON.stringify({ type: "error", text: "Ник 2-16 символов" }));
                recordIPAttempt(ip);
                return;
            }
            if (!password || password.length < 3) {
                ws.send(JSON.stringify({ type: "error", text: "Пароль минимум 3 символа" }));
                recordIPAttempt(ip);
                return;
            }
            if (nickExistsInDB(nick)) {
                ws.send(JSON.stringify({ type: "error", text: "Пользователь уже существует" }));
                recordIPAttempt(ip);
                return;
            }
            usersDB[nick] = {
                password: hashPassword(password),
                created: new Date().toISOString(),
                profile: { bio: "", age: "", phone: "", avatar: null },
                lastChats: []
            };
            saveUsers();
            resetIPAttempts(ip);
            ws.send(JSON.stringify({ type: "register_success", text: "✅ Регистрация успешна! Теперь войдите." }));
            return;
        }

        // ===== ЛОГИН =====
        if (msg.type === "login") {
            // Проверка на блокировку IP
            if (checkIPBlock(ip)) {
                ws.send(JSON.stringify({ type: "error", text: "Слишком много попыток. Подождите 5 минут." }));
                return;
            }
            
            const nick = msg.nick?.trim();
            const password = msg.password?.trim();
            const remember = msg.remember || false;
            const deviceId = msg.deviceId;
            if (!validNick(nick)) {
                ws.send(JSON.stringify({ type: "error", text: "Неверный ник" }));
                recordIPAttempt(ip);
                return;
            }
            if (!password) {
                ws.send(JSON.stringify({ type: "error", text: "Введите пароль" }));
                recordIPAttempt(ip);
                return;
            }
            if (!nickExistsInDB(nick)) {
                ws.send(JSON.stringify({ type: "error", text: "Пользователь не найден" }));
                recordIPAttempt(ip);
                return;
            }
            if (usersDB[nick].password !== hashPassword(password)) {
                ws.send(JSON.stringify({ type: "error", text: "Неверный пароль" }));
                recordIPAttempt(ip);
                return;
            }
            
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
            resetIPAttempts(ip);
            ws.send(JSON.stringify({
                type: "login_success",
                nick: nick,
                profile: usersDB[nick].profile || {},
                token: token,
                deviceId: finalDeviceId,
                groups: Object.values(groups).filter(g => g.members.includes(nick)),
                channels: getChannelsForUser(nick),
                lastChats: getLastChats(nick),
                isDima: nick === "Дима",
                reputation: userReputation.get(nick) || 0
            }));
            sendUsers();
            return;
        }

        if (!ws.nick) {
            ws.send(JSON.stringify({ type: "error", text: "Сначала войдите" }));
            return;
        }

        const currentUser = ws.nick;

        // ===== СТАТУС =====
        if (msg.type === "update_status") {
            const validStatuses = ["online", "away", "offline", "busy"];
            if (validStatuses.includes(msg.status)) {
                userStatus.set(currentUser, { status: msg.status, lastSeen: Date.now() });
                userLastSeen.set(currentUser, Date.now());
                sendUsers();
            }
            return;
        }

        // ===== ПРОФИЛЬ =====
        if (msg.type === "get_profile") {
            if (usersDB[msg.nick]) {
                ws.send(JSON.stringify({
                    type: "profile_data",
                    nick: msg.nick,
                    profile: usersDB[msg.nick].profile || {},
                    reputation: userReputation.get(msg.nick) || 0,
                    isOnline: usersOnline.has(msg.nick),
                    lastSeen: userLastSeen.get(msg.nick) || null
                }));
            }
            return;
        }

        if (msg.type === "update_profile") {
            if (!usersDB[currentUser].profile) usersDB[currentUser].profile = {};
            const profile = usersDB[currentUser].profile;
            if (msg.bio !== undefined) profile.bio = escapeHtml(msg.bio.slice(0, 200));
            if (msg.age !== undefined) profile.age = escapeHtml(msg.age.slice(0, 3));
            if (msg.phone !== undefined) profile.phone = escapeHtml(msg.phone.slice(0, 20));
            if (msg.avatar !== undefined) profile.avatar = msg.avatar;
            saveUsers();
            ws.send(JSON.stringify({ type: "profile_updated", profile }));
            return;
        }

        // ===== КАНАЛЫ =====
        if (msg.type === "create_channel") {
            if (currentUser !== "Дима") {
                ws.send(JSON.stringify({ type: "error", text: "Только администратор может создавать каналы" }));
                return;
            }
            if (!msg.name || !msg.name.trim()) {
                ws.send(JSON.stringify({ type: "error", text: "Введите название канала" }));
                return;
            }
            const channelId = createChannel(msg.name, currentUser);
            if (channelId) {
                ws.send(JSON.stringify({ type: "channel_created", channel: channels[channelId] }));
                broadcast({ type: "channel_update", channel: channels[channelId] });
            }
            return;
        }

        if (msg.type === "subscribe_channel") {
            if (subscribeToChannel(msg.channelId, currentUser)) {
                ws.send(JSON.stringify({ type: "channel_subscribed", channelId: msg.channelId }));
                broadcast({ type: "channel_update", channel: channels[msg.channelId] });
            }
            return;
        }

        if (msg.type === "channel_chat") {
            if (!checkRate(ws)) {
                ws.send(JSON.stringify({ type: "error", text: "Слишком много сообщений" }));
                return;
            }
            sendChannelMessage(msg.channelId, currentUser, msg);
            return;
        }

        if (msg.type === "get_channel_history") {
            if (channels[msg.channelId]) {
                ws.send(JSON.stringify({
                    type: "channel_history",
                    channelId: msg.channelId,
                    data: channels[msg.channelId].messages
                }));
            }
            return;
        }

        if (msg.type === "get_channel_info") {
            if (channels[msg.channelId]) {
                ws.send(JSON.stringify({
                    type: "channel_info",
                    channelId: msg.channelId,
                    channel: channels[msg.channelId]
                }));
            }
            return;
        }

        if (msg.type === "get_my_channels") {
            ws.send(JSON.stringify({
                type: "my_channels",
                channels: getChannelsForUser(currentUser)
            }));
            return;
        }

        // ===== ГРУППЫ =====
        if (msg.type === "create_group") {
            if (!msg.name || !msg.name.trim()) {
                ws.send(JSON.stringify({ type: "error", text: "Введите название группы" }));
                return;
            }
            const groupId = createGroup(msg.name, currentUser);
            ws.send(JSON.stringify({ type: "group_created", group: groups[groupId] }));
            return;
        }

        if (msg.type === "invite_to_group") {
            if (!nickExistsInDB(msg.nick)) {
                ws.send(JSON.stringify({ type: "error", text: `Пользователь "${msg.nick}" не найден` }));
                return;
            }
            if (addToGroup(msg.groupId, msg.nick)) {
                ws.send(JSON.stringify({ type: "invite_sent", groupId: msg.groupId, nick: msg.nick }));
                sendToUser(msg.nick, { type: "group_invite", groupId: msg.groupId, from: currentUser });
            } else {
                ws.send(JSON.stringify({ type: "error", text: "Пользователь уже в группе" }));
            }
            return;
        }

        if (msg.type === "group_chat") {
            if (!checkRate(ws)) {
                ws.send(JSON.stringify({ type: "error", text: "Слишком много сообщений" }));
                return;
            }
            sendGroupMessage(msg.groupId, currentUser, msg);
            return;
        }

        if (msg.type === "get_group_history") {
            if (groups[msg.groupId] && groups[msg.groupId].members.includes(currentUser)) {
                ws.send(JSON.stringify({
                    type: "group_history",
                    groupId: msg.groupId,
                    data: groups[msg.groupId].messages
                }));
            }
            return;
        }

        if (msg.type === "get_group_info") {
            if (groups[msg.groupId]) {
                ws.send(JSON.stringify({
                    type: "group_info",
                    groupId: msg.groupId,
                    group: groups[msg.groupId]
                }));
            }
            return;
        }

        if (msg.type === "get_my_groups") {
            ws.send(JSON.stringify({
                type: "my_groups",
                groups: Object.values(groups).filter(g => g.members.includes(currentUser))
            }));
            return;
        }

        // ===== ОПРОСЫ =====
        if (msg.type === "create_poll") {
            if (addPollToGroup(msg.groupId, { question: msg.question, options: msg.options }, currentUser)) {
                ws.send(JSON.stringify({ type: "poll_created", groupId: msg.groupId }));
            }
            return;
        }

        if (msg.type === "vote_poll") {
            if (voteInPoll(msg.groupId, msg.pollId, msg.option, currentUser)) {
                ws.send(JSON.stringify({ type: "poll_voted", pollId: msg.pollId }));
            }
            return;
        }

        // ===== ПУБЛИЧНЫЙ ЧАТ =====
        if (msg.type === "chat") {
            if (!checkRate(ws)) {
                ws.send(JSON.stringify({ type: "error", text: "Слишком много сообщений" }));
                return;
            }
            if (msg.text && msg.text.length > 500) {
                ws.send(JSON.stringify({ type: "error", text: "Сообщение слишком длинное" }));
                return;
            }
            const m = {
                id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
                text: escapeHtml((msg.text || "").slice(0, 500)),
                image: msg.image || null,
                video: msg.video || null,
                circle: msg.circle || null,
                file: msg.file || null,
                music: msg.music || null,
                voice: msg.voice || null,
                sticker: msg.sticker || null,
                location: msg.location || null,
                owner: currentUser,
                time: Date.now(),
                timeFormatted: formatTime(Date.now()),
                reactions: {},
                readBy: [currentUser],
                replyTo: msg.replyTo || null,
                edited: false,
                chatId: "public"
            };
            history.push(m);
            if (history.length > 500) history = history.slice(-500);
            savePublic();
            updateLastChat(currentUser, "public", "public", m.text || "📎 Вложение");
            broadcast({ type: "msg", data: m });
            return;
        }

        // ===== ЛИЧНЫЙ ЧАТ =====
        if (msg.type === "private_chat") {
            if (!checkRate(ws)) {
                ws.send(JSON.stringify({ type: "error", text: "Слишком много сообщений" }));
                return;
            }
            if (isBlocked(currentUser, msg.target) || isBlocked(msg.target, currentUser)) {
                ws.send(JSON.stringify({ type: "error", text: "Пользователь заблокирован" }));
                return;
            }
            if (msg.text && msg.text.length > 500) {
                ws.send(JSON.stringify({ type: "error", text: "Сообщение слишком длинное" }));
                return;
            }
            const key = getPrivateKey(currentUser, msg.target);
            if (!privateHistory[key]) privateHistory[key] = [];
            const m = {
                id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 8),
                from: currentUser,
                to: msg.target,
                text: escapeHtml((msg.text || "").slice(0, 500)),
                image: msg.image || null,
                video: msg.video || null,
                circle: msg.circle || null,
                file: msg.file || null,
                music: msg.music || null,
                voice: msg.voice || null,
                sticker: msg.sticker || null,
                location: msg.location || null,
                time: Date.now(),
                timeFormatted: formatTime(Date.now()),
                reactions: {},
                readBy: [currentUser],
                replyTo: msg.replyTo || null,
                edited: false,
                chatId: `private_${msg.target}`
            };
            privateHistory[key].push(m);
            if (privateHistory[key].length > 500) privateHistory[key] = privateHistory[key].slice(-500);
            savePrivate();
            updateLastChat(currentUser, "private", msg.target, m.text || "📎 Вложение");
            updateLastChat(msg.target, "private", currentUser, m.text || "📎 Вложение");
            sendToUser(currentUser, { type: "private_msg", data: m, with: msg.target });
            sendToUser(msg.target, { type: "private_msg", data: m, with: currentUser });
            return;
        }

        // ===== РЕДАКТИРОВАНИЕ =====
        if (msg.type === "edit") {
            if (editMessage(msg.chatType, msg.chatId, msg.id, msg.text, currentUser)) {
                ws.send(JSON.stringify({ type: "edit_success", id: msg.id }));
            }
            return;
        }

        // ===== УДАЛЕНИЕ =====
        if (msg.type === "delete") {
            if (deleteMessage(msg.chatType, msg.chatId, msg.id, currentUser)) {
                ws.send(JSON.stringify({ type: "delete_success", id: msg.id }));
            }
            return;
        }

        // ===== ЗАКРЕПЛЕНИЕ =====
        if (msg.type === "pin_message") {
            if (pinMessage(msg.chatId, msg.msgId, currentUser)) {
                ws.send(JSON.stringify({ type: "pin_success", id: msg.msgId }));
            }
            return;
        }

        if (msg.type === "unpin_message") {
            if (unpinMessage(msg.msgId, currentUser)) {
                ws.send(JSON.stringify({ type: "unpin_success", id: msg.msgId }));
            }
            return;
        }

        // ===== ПЛАНИРОВЩИК =====
        if (msg.type === "schedule_message") {
            if (!msg.text || !msg.scheduledTime) {
                ws.send(JSON.stringify({ type: "error", text: "Укажите текст и время" }));
                return;
            }
            if (msg.scheduledTime < Date.now()) {
                ws.send(JSON.stringify({ type: "error", text: "Время должно быть в будущем" }));
                return;
            }
            const scheduled = scheduleMessage(msg.chatId, msg.text, msg.scheduledTime, currentUser);
            ws.send(JSON.stringify({ type: "scheduled_message", data: scheduled }));
            return;
        }

        // ===== ПЕРЕВОД =====
        if (msg.type === "translate") {
            const translated = translateText(msg.text, msg.targetLang || "ru");
            ws.send(JSON.stringify({
                type: "translation",
                translatedText: translated,
                originalText: msg.text,
                targetLang: msg.targetLang
            }));
            return;
        }

        // ===== ПРОЧИТАНО =====
        if (msg.type === "mark_read") {
            markAsRead(msg.chatType, msg.chatId, msg.msgId, currentUser);
            return;
        }

        // ===== РЕАКЦИИ =====
        if (msg.type === "reaction") {
            updateReaction(msg.chatType, msg.id, currentUser, msg.reaction, msg.remove);
            return;
        }

        // ===== ПЕЧАТАЕТ =====
        if (msg.type === "typing") {
            let targetWs = null;
            for (const [c, nick] of usersOnline.entries()) {
                if (nick === msg.to) { targetWs = c; break; }
            }
            if (targetWs && targetWs.readyState === 1) {
                targetWs.send(JSON.stringify({
                    type: "typing",
                    from: currentUser,
                    isTyping: msg.isTyping,
                    chatType: msg.chatType
                }));
            }
            return;
        }

        // ===== ИСТОРИЯ =====
        if (msg.type === "get_private_history") {
            const key = getPrivateKey(currentUser, msg.with);
            ws.send(JSON.stringify({
                type: "private_history",
                with: msg.with,
                data: (privateHistory[key] || []).map(m => ({ ...m, timeFormatted: formatTime(m.time) }))
            }));
            return;
        }

        if (msg.type === "get_history") {
            ws.send(JSON.stringify({
                type: "history",
                data: history.slice(-500).map(m => ({ ...m, timeFormatted: formatTime(m.time) }))
            }));
            return;
        }

        if (msg.type === "get_last_chats") {
            ws.send(JSON.stringify({
                type: "last_chats",
                data: getLastChats(currentUser)
            }));
            return;
        }

        // ===== ЗАГРУЗКА ФАЙЛОВ =====
        if (msg.type === "upload_file") {
            handleUpload(ws, msg, "files", "file_uploaded");
            return;
        }

        if (msg.type === "upload_music") {
            handleUpload(ws, msg, "music", "music_uploaded");
            return;
        }

        if (msg.type === "upload_voice") {
            if (msg.data && msg.data.length > 5 * 1024 * 1024) {
                ws.send(JSON.stringify({ type: "error", text: "Голосовое слишком большое (макс 5MB)" }));
                return;
            }
            const filename = Date.now() + "_" + currentUser + ".webm";
            const filepath = path.join("voice", filename);
            try {
                fs.writeFileSync(filepath, Buffer.from(msg.data, "base64"));
                ws.send(JSON.stringify({ type: "voice_uploaded", url: `/voice/${filename}` }));
            } catch(e) {
                ws.send(JSON.stringify({ type: "error", text: "Ошибка сохранения голосового" }));
            }
            return;
        }

        if (msg.type === "upload_sticker") {
            if (msg.data && msg.data.length > 1 * 1024 * 1024) {
                ws.send(JSON.stringify({ type: "error", text: "Стикер слишком большой (макс 1MB)" }));
                return;
            }
            const filename = Date.now() + "_" + currentUser + ".png";
            const filepath = path.join("stickers", filename);
            try {
                fs.writeFileSync(filepath, Buffer.from(msg.data, "base64"));
                ws.send(JSON.stringify({ type: "sticker_uploaded", url: `/stickers/${filename}` }));
            } catch(e) {
                ws.send(JSON.stringify({ type: "error", text: "Ошибка сохранения стикера" }));
            }
            return;
        }

        if (msg.type === "add_sticker") {
            if (!usersDB[currentUser].stickers) usersDB[currentUser].stickers = [];
            if (!usersDB[currentUser].stickers.includes(msg.url)) {
                usersDB[currentUser].stickers.push(msg.url);
                saveUsers();
            }
            return;
        }

        // ===== WEBRTC ЗВОНКИ =====
        if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice") {
            let targetWs = null;
            for (const [c, nick] of usersOnline.entries()) {
                if (nick === msg.to) { targetWs = c; break; }
            }
            if (targetWs && targetWs.readyState === 1) {
                targetWs.send(JSON.stringify({
                    type: msg.type,
                    from: currentUser,
                    offer: msg.offer,
                    answer: msg.answer,
                    ice: msg.ice,
                    video: msg.video || false
                }));
            }
            return;
        }

        // ===== БЛОКИРОВКА =====
        if (msg.type === "block_user") {
            if (!userBlocks.has(currentUser)) userBlocks.set(currentUser, []);
            if (!userBlocks.get(currentUser).includes(msg.target)) {
                userBlocks.get(currentUser).push(msg.target);
                ws.send(JSON.stringify({ type: "block_success", target: msg.target }));
            }
            return;
        }

        if (msg.type === "unblock_user") {
            if (userBlocks.has(currentUser)) {
                userBlocks.set(currentUser, userBlocks.get(currentUser).filter(b => b !== msg.target));
                ws.send(JSON.stringify({ type: "unblock_success", target: msg.target }));
            }
            return;
        }

        // ===== РЕПУТАЦИЯ =====
        if (msg.type === "change_reputation") {
            if (currentUser !== "Дима") {
                ws.send(JSON.stringify({ type: "error", text: "Только администратор" }));
                return;
            }
            const current = userReputation.get(msg.target) || 0;
            userReputation.set(msg.target, current + msg.change);
            saveReputation();
            sendUsers();
            broadcast({ type: "reputation_update", target: msg.target, reputation: userReputation.get(msg.target) });
            ws.send(JSON.stringify({ type: "reputation_changed", target: msg.target, reputation: userReputation.get(msg.target) }));
            return;
        }
    });

    ws.on("close", () => {
        if (ws.nick) {
            usersOnline.delete(ws);
            userStatus.set(ws.nick, { status: "offline", lastSeen: Date.now() });
            userLastSeen.set(ws.nick, Date.now());
            sendUsers();
        }
        rate.delete(ws);
    });
});

// ============================================================
// ПИНГИ
// ============================================================

setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// ============================================================
// ЗАПУСК
// ============================================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`📊 Статистика:`);
    console.log(`   - Пользователей: ${Object.keys(usersDB).length}`);
    console.log(`   - Сообщений: ${history.length}`);
    console.log(`   - Групп: ${Object.keys(groups).length}`);
    console.log(`   - Каналов: ${Object.keys(channels).length}`);
    console.log(`   - Закреплённых: ${pinnedMessages.length}`);
    console.log(`   - Запланированных: ${scheduledMessages.length}`);
});
