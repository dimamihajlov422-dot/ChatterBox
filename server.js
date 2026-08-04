const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

// ============================================================
// PUSH-УВЕДОМЛЕНИЯ (Web Push, работают даже когда приложение закрыто)
// ============================================================
// Требуется пакет web-push: выполните один раз на сервере:
//   npm install web-push
// Если пакет не установлен, сервер продолжит работать как раньше —
// просто push-уведомления отправляться не будут (упадёт в catch ниже).
let webpush = null;
try { webpush = require("web-push"); } catch (e) {
    console.log("⚠️  Пакет 'web-push' не установлен — push-уведомления отключены. Выполните: npm install web-push");
}

// Сгенерированная пара VAPID-ключей (публичный ключ должен совпадать
// с тем, что зашит в index.html в функции subscribeToPush!).
// Для продакшена рекомендуется сгенерировать свою пару и держать
// приватный ключ в переменной окружения, а не в коде.
const VAPID_PUBLIC_KEY = "BEUAnMTYPjsW2bVrUblmH2IUlydTUiChaAwM4gBVZIci47qT02SxlHB3rmbI_jxUC3KkM4b8cXiyUgzh5H5myuM";
const VAPID_PRIVATE_KEY = "2zgzl3EnJu9AS4oaSx0wwnH5z_j3rpYh79RWayJWAbQ";

if (webpush) {
    webpush.setVapidDetails("mailto:admin@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// ============================================================
// ШИФРОВАНИЕ ПЕРЕПИСКИ НА ДИСКЕ (AES-256-GCM)
// ============================================================
// Защищает от кражи/утечки файлов db.json, private.json, groups.json,
// channels.json (например, если сервер взломают или скопируют бэкап).
// НЕ является end-to-end шифрованием: сам сервер по-прежнему видит
// сообщения в открытом виде в памяти, пока обрабатывает их — это
// защита "на диске", а не "от администратора сервера".
//
// Чтобы включить: задайте переменную окружения CHATTERBOX_ENCRYPTION_KEY
// (64 hex-символа = 32 байта). Сгенерировать можно командой:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// ВАЖНО: никогда не храните этот ключ в коде или git — только в
// переменных окружения/секретах хостинга. Если ключ потеряется —
// старые данные будет невозможно расшифровать.
let ENCRYPTION_KEY = null;
if (process.env.CHATTERBOX_ENCRYPTION_KEY && process.env.CHATTERBOX_ENCRYPTION_KEY.length === 64) {
    try {
        ENCRYPTION_KEY = Buffer.from(process.env.CHATTERBOX_ENCRYPTION_KEY, "hex");
        console.log("🔐 Шифрование хранилища ВКЛЮЧЕНО (AES-256-GCM)");
    } catch (e) {
        console.log("⚠️  CHATTERBOX_ENCRYPTION_KEY некорректен — шифрование хранилища отключено");
    }
} else {
    console.log("⚠️  CHATTERBOX_ENCRYPTION_KEY не задан — сообщения хранятся в открытом виде. Задайте переменную окружения, чтобы включить шифрование на диске.");
}

function encryptText(text) {
    if (!ENCRYPTION_KEY || text === null || text === undefined || text === "") return text;
    try {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
        const enc = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
        const tag = cipher.getAuthTag();
        return "enc:" + iv.toString("hex") + ":" + tag.toString("hex") + ":" + enc.toString("hex");
    } catch (e) { return text; }
}

function decryptText(payload) {
    if (!ENCRYPTION_KEY || typeof payload !== "string" || !payload.startsWith("enc:")) return payload;
    try {
        const parts = payload.split(":");
        if (parts.length !== 4) return payload;
        const [, ivHex, tagHex, dataHex] = parts;
        const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, Buffer.from(ivHex, "hex"));
        decipher.setAuthTag(Buffer.from(tagHex, "hex"));
        const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
        return dec.toString("utf8");
    } catch (e) {
        return "[не удалось расшифровать — неверный ключ?]";
    }
}

// Шифрует/расшифровывает поле text у сообщений и их комментариев (для
// каналов). Возвращает НОВЫЕ объекты, не мутирует исходные — это важно,
// т.к. те же message-объекты рассылаются другим пользователям по WebSocket
// в открытом виде (шифруется только то, что реально пишется на диск).
function encryptMessagesForSave(messages) {
    if (!ENCRYPTION_KEY || !Array.isArray(messages)) return messages;
    return messages.map(m => {
        const copy = { ...m };
        if (copy.text) copy.text = encryptText(copy.text);
        if (Array.isArray(copy.comments)) {
            copy.comments = copy.comments.map(c => c.text ? { ...c, text: encryptText(c.text) } : c);
        }
        return copy;
    });
}

function decryptMessagesAfterLoad(messages) {
    if (!ENCRYPTION_KEY || !Array.isArray(messages)) return messages;
    return messages.map(m => {
        const copy = { ...m };
        if (copy.text) copy.text = decryptText(copy.text);
        if (Array.isArray(copy.comments)) {
            copy.comments = copy.comments.map(c => c.text ? { ...c, text: decryptText(c.text) } : c);
        }
        return copy;
    });
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Базовые security-заголовки (без внешних зависимостей вроде helmet)
app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");   // запрет MIME-sniffing
    res.setHeader("X-Frame-Options", "DENY");              // запрет встраивания в iframe (clickjacking)
    res.setHeader("Referrer-Policy", "no-referrer");        // не палим URL в заголовке Referer
    res.setHeader("Permissions-Policy", "interest-cohort=()"); // отключаем FLoC-подобное отслеживание
    next();
});

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
let privatePinned = {};
let scheduledMessages = [];
let ipAttempts = new Map();
let ipBlockedUntil = new Map();
let pushSubscriptions = {}; // nick -> [subscription, ...] (несколько устройств на пользователя)

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
const PUSH_FILE = "push_subscriptions.json";
const BLOCKS_FILE = "blocks.json";
const PRIVATE_PINNED_FILE = "private_pinned.json";

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
            history = decryptMessagesAfterLoad(JSON.parse(fs.readFileSync(DB_FILE, "utf8")) || []);
            console.log(`✅ Загружено ${history.length} сообщений`);
        } else {
            history = [];
            fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
        }
    } catch (e) { history = []; }

    try {
        if (fs.existsSync(PRIVATE_FILE)) {
            const raw = JSON.parse(fs.readFileSync(PRIVATE_FILE, "utf8")) || {};
            privateHistory = {};
            for (const key in raw) privateHistory[key] = decryptMessagesAfterLoad(raw[key]);
            console.log(`✅ Загружено ${Object.keys(privateHistory).length} диалогов`);
        } else {
            privateHistory = {};
            fs.writeFileSync(PRIVATE_FILE, JSON.stringify({}, null, 2));
        }
    } catch (e) { privateHistory = {}; }

    try {
        if (fs.existsSync(GROUPS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(GROUPS_FILE, "utf8")) || {};
            groups = {};
            for (const id in raw) groups[id] = { ...raw[id], messages: decryptMessagesAfterLoad(raw[id].messages) };
            console.log(`✅ Загружено ${Object.keys(groups).length} групп`);
        } else {
            groups = {};
            fs.writeFileSync(GROUPS_FILE, JSON.stringify({}, null, 2));
        }
    } catch (e) { groups = {}; }

    try {
        if (fs.existsSync(CHANNELS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8")) || {};
            channels = {};
            for (const id in raw) channels[id] = { ...raw[id], messages: decryptMessagesAfterLoad(raw[id].messages) };
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

    try {
        if (fs.existsSync(PUSH_FILE)) {
            pushSubscriptions = JSON.parse(fs.readFileSync(PUSH_FILE, "utf8")) || {};
            console.log(`✅ Загружено push-подписок: ${Object.keys(pushSubscriptions).length} пользователей`);
        } else {
            pushSubscriptions = {};
            fs.writeFileSync(PUSH_FILE, JSON.stringify({}, null, 2));
        }
    } catch (e) { pushSubscriptions = {}; }

    try {
        if (fs.existsSync(BLOCKS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(BLOCKS_FILE, "utf8")) || {};
            userBlocks = new Map(Object.entries(raw));
            console.log(`✅ Загружено блокировок: у ${userBlocks.size} пользователей`);
        } else {
            userBlocks = new Map();
            fs.writeFileSync(BLOCKS_FILE, JSON.stringify({}, null, 2));
        }
    } catch (e) { userBlocks = new Map(); }

    try {
        if (fs.existsSync(PRIVATE_PINNED_FILE)) {
            privatePinned = JSON.parse(fs.readFileSync(PRIVATE_PINNED_FILE, "utf8")) || {};
            console.log(`✅ Загружено закреплений в личных чатах: ${Object.keys(privatePinned).length}`);
        } else {
            privatePinned = {};
            fs.writeFileSync(PRIVATE_PINNED_FILE, JSON.stringify({}, null, 2));
        }
    } catch (e) { privatePinned = {}; }
}

loadData();

// ============================================================
// СОХРАНЕНИЕ
// ============================================================

function saveUsers() { try { fs.writeFileSync(USERS_FILE, JSON.stringify(usersDB, null, 2)); } catch(e){} }
function savePublic() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(encryptMessagesForSave(history.slice(-500)), null, 2));
    } catch(e){}
}
function savePrivate() {
    try {
        const out = {};
        for (const key in privateHistory) out[key] = encryptMessagesForSave(privateHistory[key]);
        fs.writeFileSync(PRIVATE_FILE, JSON.stringify(out, null, 2));
    } catch(e){}
}
function saveGroups() {
    try {
        const out = {};
        for (const id in groups) out[id] = { ...groups[id], messages: encryptMessagesForSave(groups[id].messages) };
        fs.writeFileSync(GROUPS_FILE, JSON.stringify(out, null, 2));
    } catch(e){}
}
function saveChannels() {
    try {
        const out = {};
        for (const id in channels) out[id] = { ...channels[id], messages: encryptMessagesForSave(channels[id].messages) };
        fs.writeFileSync(CHANNELS_FILE, JSON.stringify(out, null, 2));
    } catch(e){}
}
function saveSessions() { try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2)); } catch(e){} }
function saveComplaints() { try { fs.writeFileSync(COMPLAINTS_FILE, JSON.stringify(complaints, null, 2)); } catch(e){} }
function saveReputation() { try { fs.writeFileSync(REPUTATION_FILE, JSON.stringify(Object.fromEntries(userReputation), null, 2)); } catch(e){} }
function saveDevices() { try { fs.writeFileSync(DEVICES_FILE, JSON.stringify(deviceTokens, null, 2)); } catch(e){} }
function savePinned() { try { fs.writeFileSync(PINNED_FILE, JSON.stringify(pinnedMessages, null, 2)); } catch(e){} }
function saveScheduled() { try { fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(scheduledMessages, null, 2)); } catch(e){} }
function savePushSubscriptions() { try { fs.writeFileSync(PUSH_FILE, JSON.stringify(pushSubscriptions, null, 2)); } catch(e){} }
function saveBlocks() { try { fs.writeFileSync(BLOCKS_FILE, JSON.stringify(Object.fromEntries(userBlocks), null, 2)); } catch(e){} }

// Отправляет push-уведомление пользователю на ВСЕ его сохранённые устройства.
// Вызывается только когда пользователь offline (иначе он и так получит
// сообщение мгновенно через WebSocket — дублировать push не нужно).
function sendPushToUser(nick, { title, body, tag }) {
    if (!webpush) return;
    const subs = pushSubscriptions[nick];
    if (!subs || subs.length === 0) return;
    const payload = JSON.stringify({ title: title || "ChatterBox", body: (body || "").slice(0, 150), tag: tag || nick });
    let changed = false;
    pushSubscriptions[nick] = subs.filter(sub => {
        webpush.sendNotification(sub, payload).catch(err => {
            // 404/410 = подписка больше недействительна (например, юзер очистил данные браузера)
            if (err && (err.statusCode === 404 || err.statusCode === 410)) {
                pushSubscriptions[nick] = (pushSubscriptions[nick] || []).filter(s => s.endpoint !== sub.endpoint);
                savePushSubscriptions();
            }
        });
        return true;
    });
    if (changed) savePushSubscriptions();
}

// ============================================================
// УТИЛИТЫ
// ============================================================

function hashPassword(p) { return crypto.createHash("sha256").update(p).digest("hex"); } // оставлено для обратной совместимости (старые аккаунты)

// Надёжное хеширование: scrypt + случайная соль на каждого пользователя.
// Формат хранения: "scrypt:<соль>:<хеш>" — так его можно отличить от старого
// формата (просто 64 hex-символа sha256) и не сломать существующие аккаунты.
function hashPasswordSecure(password, salt) {
    salt = salt || crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
    if (typeof stored === "string" && stored.startsWith("scrypt:")) {
        const parts = stored.split(":");
        if (parts.length !== 3) return false;
        const [, salt, hash] = parts;
        try {
            const check = crypto.scryptSync(password, salt, 64).toString("hex");
            const a = Buffer.from(hash, "hex");
            const b = Buffer.from(check, "hex");
            return a.length === b.length && crypto.timingSafeEqual(a, b);
        } catch (e) { return false; }
    }
    // Старый формат (нешифрованный sha256 без соли) — поддерживаем для уже
    // зарегистрированных аккаунтов, чтобы никого не выкинуть из профиля
    return hashPassword(password) === stored;
}
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

// Если у ника уже есть "старое" соединение (например, приложение было
// закрыто, но сервер ещё не успел это обнаружить через ping/pong —
// такое обнаружение происходит раз в 30 секунд), новый вход должен
// ЗАМЕНИТЬ старую сессию, а не блокировать вход и не создавать
// второй параллельный "призрачный" коннект на тот же ник.
function kickExistingSession(nick) {
    for (const [c, n] of usersOnline.entries()) {
        if (n === nick) {
            usersOnline.delete(c);
            rate.delete(c);
            try {
                c.send(JSON.stringify({ type: "error", text: "Вы вошли с другого устройства/вкладки" }));
                c.close();
            } catch (e) {}
            try { c.terminate(); } catch (e) {}
        }
    }
}

// ============================================================
// ЗАЩИТА ОТ БРУТФОРСА
// ============================================================

function checkIPBlock(ip) {
    if (ipBlockedUntil.has(ip)) {
        if (Date.now() < ipBlockedUntil.get(ip)) {
            return true;
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
        ipBlockedUntil.set(ip, Date.now() + 5 * 60 * 1000);
        return true;
    }
    return false;
}

function resetIPAttempts(ip) {
    ipAttempts.delete(ip);
    ipBlockedUntil.delete(ip);
}

// ============================================================
// ============================================================
// ГРУППЫ — РАСШИРЕННЫЕ ФУНКЦИИ
// ============================================================
// ============================================================

function addGroupLog(groupId, action) {
    if (!groups[groupId]) return;
    if (!groups[groupId].actionLog) groups[groupId].actionLog = [];
    groups[groupId].actionLog.push({
        time: Date.now(),
        action: action,
        timeFormatted: formatTime(Date.now())
    });
    if (groups[groupId].actionLog.length > 100) {
        groups[groupId].actionLog = groups[groupId].actionLog.slice(-100);
    }
    saveGroups();
}

function getGroupLog(groupId) {
    if (!groups[groupId]) return [];
    return groups[groupId].actionLog || [];
}

// ===== 2. 🛡️ Администраторы =====
function addAdmin(groupId, nick, adder) {
    if (!groups[groupId]) return false;
    if (groups[groupId].creator !== adder && adder !== "Дима") return false;
    if (!groups[groupId].members.includes(nick)) return false;
    if (groups[groupId].admins.includes(nick)) return false;
    groups[groupId].admins.push(nick);
    saveGroups();
    broadcast({ type: "group_update", group: groups[groupId] });
    addGroupLog(groupId, `${adder} назначил ${nick} администратором`);
    return true;
}

function removeAdmin(groupId, nick, remover) {
    if (!groups[groupId]) return false;
    if (groups[groupId].creator !== remover && remover !== "Дима") return false;
    if (nick === groups[groupId].creator) return false;
    groups[groupId].admins = groups[groupId].admins.filter(a => a !== nick);
    saveGroups();
    broadcast({ type: "group_update", group: groups[groupId] });
    addGroupLog(groupId, `${remover} снял ${nick} с должности администратора`);
    return true;
}

// ===== 4. ➕ Добавление участников =====
function addMemberByNick(groupId, nick, inviter) {
    if (!groups[groupId]) return false;
    if (groups[groupId].members.includes(nick)) return false;
    if (groups[groupId].banned && groups[groupId].banned.includes(nick)) return false;
    groups[groupId].members.push(nick);
    saveGroups();
    broadcast({ type: "group_update", group: groups[groupId] });
    addGroupLog(groupId, `${inviter} пригласил ${nick}`);
    sendToUser(nick, { type: "group_invite", groupId, from: inviter });
    return true;
}

// ===== 5. ⚙️ Настройки группы =====
function updateGroupSettings(groupId, settings, updater) {
    if (!groups[groupId]) return false;
    if (groups[groupId].creator !== updater && !groups[groupId].admins.includes(updater) && updater !== "Дима") return false;
    if (!groups[groupId].settings) groups[groupId].settings = {};
    groups[groupId].settings = { ...groups[groupId].settings, ...settings };
    saveGroups();
    broadcast({ type: "group_update", group: groups[groupId] });
    addGroupLog(groupId, `${updater} изменил настройки группы`);
    return true;
}

// ===== 5a. 📝 Название группы =====
function updateGroupName(groupId, newName, updater) {
    if (!groups[groupId]) return false;
    if (!newName || !newName.trim()) return false;
    const settings = groups[groupId].settings || {};
    const isAdmin = groups[groupId].admins && groups[groupId].admins.includes(updater);
    const perm = settings.whoCanChangeName || "admins";
    const allowed = groups[groupId].creator === updater || updater === "Дима" ||
        (perm === "all") || (perm === "admins" && isAdmin);
    if (!allowed) return false;
    groups[groupId].name = escapeHtml(newName.trim().slice(0, 50));
    saveGroups();
    broadcast({ type: "group_update", group: groups[groupId] });
    addGroupLog(groupId, `${updater} изменил название группы на "${groups[groupId].name}"`);
    return true;
}

// ===== 7. 🔗 Пригласительная ссылка =====
function generateInviteLink(groupId) {
    if (!groups[groupId]) return null;
    const token = crypto.randomBytes(16).toString("hex");
    const link = `/join/${groupId}/${token}`;
    groups[groupId].inviteLink = link;
    groups[groupId].inviteToken = token;
    saveGroups();
    return link;
}

function getInviteLink(groupId) {
    if (!groups[groupId]) return null;
    if (!groups[groupId].inviteLink) {
        return generateInviteLink(groupId);
    }
    return groups[groupId].inviteLink;
}

function joinByInviteLink(groupId, token, nick) {
    if (!groups[groupId]) return false;
    if (groups[groupId].inviteToken !== token) return false;
    if (groups[groupId].banned && groups[groupId].banned.includes(nick)) return false;
    if (groups[groupId].members.includes(nick)) return false;
    groups[groupId].members.push(nick);
    saveGroups();
    broadcast({ type: "group_update", group: groups[groupId] });
    addGroupLog(groupId, `${nick} присоединился по ссылке`);
    return true;
}

// ===== 8. 🔒 Проверка прав =====
function checkGroupPermission(groupId, action, nick) {
    if (!groups[groupId]) return false;
    if (groups[groupId].creator === nick) return true;
    if (nick === "Дима") return true;
    
    const settings = groups[groupId].settings || {};
    const isAdmin = groups[groupId].admins && groups[groupId].admins.includes(nick);
    
    switch(action) {
        case "send_message":
            return settings.whoCanSendMessages === "all" || (settings.whoCanSendMessages === "admins" && isAdmin) || settings.whoCanSendMessages === undefined;
        case "call":
            return settings.whoCanCall === "all" || (settings.whoCanCall === "admins" && isAdmin) || settings.whoCanCall === undefined;
        case "invite":
            return settings.whoCanInvite === "all" || (settings.whoCanInvite === "admins" && isAdmin) || settings.whoCanInvite === undefined;
        case "change_name":
            return settings.whoCanChangeName === "all" || (settings.whoCanChangeName === "admins" && isAdmin) || settings.whoCanChangeName === undefined;
        case "change_avatar":
            return settings.whoCanChangeAvatar === "all" || (settings.whoCanChangeAvatar === "admins" && isAdmin) || settings.whoCanChangeAvatar === undefined;
        case "pin":
            return settings.whoCanPin === "all" || (settings.whoCanPin === "admins" && isAdmin) || settings.whoCanPin === undefined;
        default:
            return false;
    }
}

// ===== 9. 📌 Закреплённые сообщения =====
function pinGroupMessage(groupId, msgId, pinner) {
    if (!groups[groupId]) return false;
    if (!checkGroupPermission(groupId, "pin", pinner)) return false;
    const msg = groups[groupId].messages.find(m => m.id === msgId);
    if (!msg) return false;
    if (!groups[groupId].pinnedMessages) groups[groupId].pinnedMessages = [];
    if (groups[groupId].pinnedMessages.includes(msgId)) return false;
    groups[groupId].pinnedMessages.push(msgId);
    saveGroups();
    broadcast({ type: "group_update", group: groups[groupId] });
    addGroupLog(groupId, `${pinner} закрепил сообщение`);
    return true;
}

function unpinGroupMessage(groupId, msgId, unpinner) {
    if (!groups[groupId]) return false;
    if (!checkGroupPermission(groupId, "pin", unpinner)) return false;
    if (!groups[groupId].pinnedMessages) groups[groupId].pinnedMessages = [];
    groups[groupId].pinnedMessages = groups[groupId].pinnedMessages.filter(id => id !== msgId);
    saveGroups();
    broadcast({ type: "group_update", group: groups[groupId] });
    addGroupLog(groupId, `${unpinner} открепил сообщение`);
    return true;
}

// ===== Закрепление в публичном и личном чате =====
// pinnedMessages (публичный чат) — общий для всех, т.к. сам чат публичный.
// privatePinned (личные чаты) — НЕ рассылается всем подряд, только двум
// участникам конкретной переписки, иначе это была бы утечка чужих личных
// сообщений остальным пользователям при подключении.
function savePrivatePinned() { try { fs.writeFileSync(PRIVATE_PINNED_FILE, JSON.stringify(privatePinned, null, 2)); } catch(e){} }

function pinMessage(chatType, chatId, msgId, pinner) {
    let target = null;
    if (chatType === "public") {
        target = history.find(m => m.id === msgId);
    } else if (chatType === "private") {
        const arr = privateHistory[chatId];
        target = arr ? arr.find(m => m.id === msgId) : null;
        if (target && target.from !== pinner && target.to !== pinner) return null; // не участник переписки
    }
    if (!target) return null;

    const pinEntry = {
        id: msgId,
        chatType,
        chatId,
        text: target.text || "",
        from: target.from || target.owner,
        time: target.time,
        timeFormatted: target.timeFormatted
    };

    if (chatType === "public") {
        if (!pinnedMessages.find(p => p.id === msgId)) pinnedMessages.push(pinEntry);
        savePinned();
        broadcast({ type: "pinned_updated", message: pinEntry });
    } else if (chatType === "private") {
        if (!privatePinned[chatId]) privatePinned[chatId] = [];
        if (!privatePinned[chatId].find(p => p.id === msgId)) privatePinned[chatId].push(pinEntry);
        savePrivatePinned();
        sendToUser(target.from, { type: "pinned_updated", message: pinEntry });
        sendToUser(target.to, { type: "pinned_updated", message: pinEntry });
    }
    return pinEntry;
}

function unpinMessage(chatType, chatId, msgId, unpinner) {
    if (chatType === "public") {
        pinnedMessages = pinnedMessages.filter(p => p.id !== msgId);
        savePinned();
        broadcast({ type: "pinned_removed", unpinId: msgId });
        return true;
    } else if (chatType === "private") {
        if (!privatePinned[chatId]) return false;
        const arr = privateHistory[chatId];
        const target = arr ? arr.find(m => m.id === msgId) : null;
        privatePinned[chatId] = privatePinned[chatId].filter(p => p.id !== msgId);
        savePrivatePinned();
        if (target) {
            sendToUser(target.from, { type: "pinned_removed", unpinId: msgId });
            sendToUser(target.to, { type: "pinned_removed", unpinId: msgId });
        } else {
            unbindFallbackUnpin(unpinner, msgId);
        }
        return true;
    }
    return false;
}
function unbindFallbackUnpin(unpinner, msgId) {
    sendToUser(unpinner, { type: "pinned_removed", unpinId: msgId });
}

// ===== 10. 🖼️ Фото и описание =====
function updateGroupAvatar(groupId, avatar, updater) {
    if (!groups[groupId]) return false;
    if (!checkGroupPermission(groupId, "change_avatar", updater)) return false;
    groups[groupId].avatar = avatar;
    saveGroups();
    broadcast({ type: "group_update", group: groups[groupId] });
    addGroupLog(groupId, `${updater} обновил аватар группы`);
    return true;
}

function updateGroupDescription(groupId, description, updater) {
    if (!groups[groupId]) return false;
    if (groups[groupId].creator !== updater && !groups[groupId].admins.includes(updater) && updater !== "Дима") return false;
    groups[groupId].description = escapeHtml(description.slice(0, 500));
    saveGroups();
    broadcast({ type: "group_update", group: groups[groupId] });
    addGroupLog(groupId, `${updater} обновил описание группы`);
    return true;
}

// ===== 11. 🔍 Поиск =====
function searchGroupMessages(groupId, query) {
    if (!groups[groupId]) return [];
    const q = query.toLowerCase();
    return groups[groupId].messages.filter(m => 
        m.text && m.text.toLowerCase().includes(q)
    );
}

// ===== 12. 📂 Медиа, файлы, ссылки =====
function getGroupMedia(groupId) {
    if (!groups[groupId]) return [];
    return groups[groupId].messages.filter(m => 
        m.image || m.video || m.circle || m.file || m.music || m.voice
    );
}

function getGroupFiles(groupId) {
    if (!groups[groupId]) return [];
    return groups[groupId].messages.filter(m => m.file);
}

function getGroupLinks(groupId) {
    if (!groups[groupId]) return [];
    const links = [];
    groups[groupId].messages.forEach(m => {
        if (m.text) {
            const urls = m.text.match(/(https?:\/\/[^\s]+)/g);
            if (urls) {
                urls.forEach(url => {
                    links.push({ url, from: m.from || m.owner, time: m.time, timeFormatted: formatTime(m.time) });
                });
            }
        }
    });
    return links;
}

// ===== 13. 🔕 Уведомления =====
function setGroupNotificationSettings(groupId, nick, settings) {
    if (!groups[groupId]) return false;
    if (!groups[groupId].members.includes(nick)) return false;
    if (!groups[groupId].notifications) groups[groupId].notifications = {};
    groups[groupId].notifications[nick] = settings;
    saveGroups();
    return true;
}

function getGroupNotificationSettings(groupId, nick) {
    if (!groups[groupId]) return { enabled: true, mentions: true };
    return groups[groupId].notifications?.[nick] || { enabled: true, mentions: true };
}

// ===== 14. 📝 Журнал действий =====
// уже есть addGroupLog и getGroupLog

// ===== 15. 🚪 Выход или удаление =====
function leaveGroup(groupId, nick) {
    if (!groups[groupId]) return false;
    if (!groups[groupId].members.includes(nick)) return false;
    if (groups[groupId].creator === nick) {
        return false; // создатель не может выйти
    }
    groups[groupId].members = groups[groupId].members.filter(m => m !== nick);
    if (groups[groupId].admins) {
        groups[groupId].admins = groups[groupId].admins.filter(a => a !== nick);
    }
    saveGroups();
    broadcast({ type: "group_update", group: groups[groupId] });
    addGroupLog(groupId, `${nick} вышел из группы`);
    return true;
}

function deleteGroup(groupId, nick) {
    if (!groups[groupId]) return false;
    if (groups[groupId].creator !== nick && nick !== "Дима") return false;
    const groupName = groups[groupId].name;
    delete groups[groupId];
    saveGroups();
    broadcast({ type: "group_deleted", groupId, groupName });
    return true;
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
        admins: [creator],          // могут постить, менять аву/название/описание, назначать comment-админов
        commentAdmins: [creator],   // могут модерировать (удалять) комментарии под постами
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

function isChannelAdmin(channelId, nick) {
    if (!channels[channelId]) return false;
    if (channels[channelId].creator === nick || nick === "Дима") return true;
    return (channels[channelId].admins || []).includes(nick);
}

function isCommentAdmin(channelId, nick) {
    if (!channels[channelId]) return false;
    if (isChannelAdmin(channelId, nick)) return true;
    return (channels[channelId].commentAdmins || []).includes(nick);
}

function addChannelAdmin(channelId, nick, adder) {
    if (!channels[channelId]) return false;
    if (channels[channelId].creator !== adder && adder !== "Дима") return false;
    if (!channels[channelId].subscribers.includes(nick)) return false;
    if (!channels[channelId].admins) channels[channelId].admins = [];
    if (channels[channelId].admins.includes(nick)) return false;
    channels[channelId].admins.push(nick);
    saveChannels();
    broadcast({ type: "channel_update", channel: channels[channelId] });
    return true;
}

function removeChannelAdmin(channelId, nick, remover) {
    if (!channels[channelId]) return false;
    if (channels[channelId].creator !== remover && remover !== "Дима") return false;
    if (nick === channels[channelId].creator) return false;
    channels[channelId].admins = (channels[channelId].admins || []).filter(a => a !== nick);
    saveChannels();
    broadcast({ type: "channel_update", channel: channels[channelId] });
    return true;
}

function addCommentAdmin(channelId, nick, adder) {
    if (!channels[channelId]) return false;
    if (!isChannelAdmin(channelId, adder)) return false;
    if (!channels[channelId].subscribers.includes(nick)) return false;
    if (!channels[channelId].commentAdmins) channels[channelId].commentAdmins = [];
    if (channels[channelId].commentAdmins.includes(nick)) return false;
    channels[channelId].commentAdmins.push(nick);
    saveChannels();
    broadcast({ type: "channel_update", channel: channels[channelId] });
    return true;
}

function removeCommentAdmin(channelId, nick, remover) {
    if (!channels[channelId]) return false;
    if (!isChannelAdmin(channelId, remover)) return false;
    if (nick === channels[channelId].creator) return false;
    channels[channelId].commentAdmins = (channels[channelId].commentAdmins || []).filter(a => a !== nick);
    saveChannels();
    broadcast({ type: "channel_update", channel: channels[channelId] });
    return true;
}

function updateChannelAvatar(channelId, avatar, updater) {
    if (!channels[channelId] || !isChannelAdmin(channelId, updater)) return false;
    channels[channelId].avatar = avatar;
    saveChannels();
    broadcast({ type: "channel_update", channel: channels[channelId] });
    return true;
}

function updateChannelName(channelId, newName, updater) {
    if (!channels[channelId] || !isChannelAdmin(channelId, updater)) return false;
    if (!newName || !newName.trim()) return false;
    channels[channelId].name = escapeHtml(newName.trim().slice(0, 50));
    saveChannels();
    broadcast({ type: "channel_update", channel: channels[channelId] });
    return true;
}

function updateChannelDescription(channelId, description, updater) {
    if (!channels[channelId] || !isChannelAdmin(channelId, updater)) return false;
    channels[channelId].description = escapeHtml((description || "").slice(0, 500));
    saveChannels();
    broadcast({ type: "channel_update", channel: channels[channelId] });
    return true;
}

function sendChannelMessage(channelId, from, msgData) {
    if (!channels[channelId]) return;
    if (!isChannelAdmin(channelId, from)) return;
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
        comments: [],
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

// ===== КОММЕНТАРИИ К ПОСТАМ КАНАЛА =====
function addChannelComment(channelId, msgId, from, text) {
    if (!channels[channelId]) return null;
    if (!channels[channelId].subscribers.includes(from)) return null;
    const post = channels[channelId].messages.find(m => m.id === msgId);
    if (!post) return null;
    if (!post.comments) post.comments = [];
    const comment = {
        id: Date.now().toString() + "-" + Math.random().toString(36).substr(2, 6),
        from,
        text: escapeHtml((text || "").slice(0, 500)),
        time: Date.now(),
        timeFormatted: formatTime(Date.now())
    };
    post.comments.push(comment);
    if (post.comments.length > 500) post.comments = post.comments.slice(-500);
    saveChannels();
    for (const sub of channels[channelId].subscribers) {
        sendToUser(sub, { type: "channel_comment_added", channelId, msgId, comment });
    }
    return comment;
}

function deleteChannelComment(channelId, msgId, commentId, deleter) {
    if (!channels[channelId]) return false;
    const post = channels[channelId].messages.find(m => m.id === msgId);
    if (!post || !post.comments) return false;
    const comment = post.comments.find(c => c.id === commentId);
    if (!comment) return false;
    if (comment.from !== deleter && !isCommentAdmin(channelId, deleter)) return false;
    post.comments = post.comments.filter(c => c.id !== commentId);
    saveChannels();
    for (const sub of channels[channelId].subscribers) {
        sendToUser(sub, { type: "channel_comment_deleted", channelId, msgId, commentId });
    }
    return true;
}

function getChannelsForUser(nick) {
    return Object.values(channels);
}

// ============================================================
// ГРУППЫ — ОСНОВНЫЕ ФУНКЦИИ
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
        description: "",
        settings: {
            whoCanSendMessages: "all",
            whoCanCall: "all",
            whoCanInvite: "all",
            whoCanChangeName: "admins",
            whoCanChangeAvatar: "admins",
            whoCanPin: "admins",
            slowMode: 0
        },
        lastMessageAt: {},
        pinnedMessages: [],
        actionLog: [],
        notifications: {},
        inviteLink: null,
        inviteToken: null,
        banned: []
    };
    saveGroups();
    addGroupLog(id, `${creator} создал группу`);
    return id;
}

function addToGroup(groupId, nick, inviter = null) {
    if (!groups[groupId] || groups[groupId].members.includes(nick)) return false;
    if (groups[groupId].banned && groups[groupId].banned.includes(nick)) return false;
    groups[groupId].members.push(nick);
    saveGroups();
    broadcast({ type: "group_update", group: groups[groupId] });
    if (inviter) {
        addGroupLog(groupId, `${inviter} пригласил ${nick}`);
    } else {
        addGroupLog(groupId, `${nick} присоединился`);
    }
    return true;
}

function removeFromGroup(groupId, nick, remover) {
    if (!groups[groupId]) return false;
    if (groups[groupId].creator !== remover && !groups[groupId].admins.includes(remover) && remover !== "Дима") return false;
    if (nick === groups[groupId].creator && remover !== "Дима") return false;
    groups[groupId].members = groups[groupId].members.filter(m => m !== nick);
    if (groups[groupId].admins) {
        groups[groupId].admins = groups[groupId].admins.filter(a => a !== nick);
    }
    saveGroups();
    broadcast({ type: "group_update", group: groups[groupId] });
    addGroupLog(groupId, `${remover} удалил ${nick} из группы`);
    return true;
}

function sendGroupMessage(groupId, from, msgData) {
    if (!groups[groupId]) return;
    if (!groups[groupId].members.includes(from)) return;
    if (!checkGroupPermission(groupId, "send_message", from)) {
        sendToUser(from, { type: "error", text: "У вас нет прав на отправку сообщений в этой группе" });
        return;
    }
    const slowMode = (groups[groupId].settings || {}).slowMode || 0;
    const isPrivileged = groups[groupId].creator === from || (groups[groupId].admins || []).includes(from) || from === "Дима";
    if (slowMode > 0 && !isPrivileged) {
        if (!groups[groupId].lastMessageAt) groups[groupId].lastMessageAt = {};
        const last = groups[groupId].lastMessageAt[from] || 0;
        const waitLeft = slowMode * 1000 - (Date.now() - last);
        if (waitLeft > 0) {
            sendToUser(from, { type: "error", text: `⏳ Медленный режим: подождите ещё ${Math.ceil(waitLeft / 1000)} сек.` });
            return;
        }
        groups[groupId].lastMessageAt[from] = Date.now();
    }
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
        replyTo: msgData.replyTo || null,
        forwardedFrom: msgData.forwardedFrom || null,
        edited: false,
        chatId: `group_${groupId}`
    };
    groups[groupId].messages.push(m);
    if (groups[groupId].messages.length > 500) {
        groups[groupId].messages = groups[groupId].messages.slice(-500);
    }
    saveGroups();
    for (const member of groups[groupId].members) {
        const delivered = sendToUser(member, { type: "group_msg", groupId, data: m });
        updateLastChat(member, "group", groupId, m.text || "📎 Вложение");
        if (!delivered && member !== from) {
            sendPushToUser(member, { title: `${groups[groupId].name}: ${from}`, body: m.text || "📎 Вложение", tag: `group_${groupId}` });
        }
    }
}

// ============================================================
// ОПРОСЫ В ГРУППАХ
// ============================================================

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
    if (!target) return false;
    if (target.owner !== editor && target.from !== editor && editor !== "Дима") return false;
    const newEscaped = escapeHtml(newText.slice(0, 500));
    if (newEscaped === target.text) return true; // текст не изменился — не помечаем как отредактированное
    target.text = newEscaped;
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
    if (!target) return false;
    if (target.owner !== deleter && target.from !== deleter && deleter !== "Дима") return false;
    if (chatType === "public") {
        history = history.filter(x => x.id !== msgId);
        savePublic();
    } else if (chatType === "private") {
        for (const key in privateHistory) {
            const idx = privateHistory[key].findIndex(x => x.id === msgId);
            if (idx !== -1) {
                privateHistory[key].splice(idx, 1);
                savePrivate();
                break;
            }
        }
    } else if (chatType === "group" && groups[chatId]) {
        groups[chatId].messages = groups[chatId].messages.filter(x => x.id !== msgId);
        saveGroups();
    } else if (chatType === "channel" && channels[chatId]) {
        channels[chatId].messages = channels[chatId].messages.filter(x => x.id !== msgId);
        saveChannels();
    }
    broadcast({ type: "delete", id: msgId });
    return true;
}

// ============================================================
// ЗАГРУЗКА ФАЙЛОВ
// ============================================================

// Расширения, которые НЕЛЬЗЯ загружать как обычный файл (исполняемые/скрипты) —
// иначе их можно будет открыть по прямой ссылке /files/... и получить RCE-подобный риск
const DANGEROUS_EXTENSIONS = [
    ".exe", ".bat", ".cmd", ".sh", ".ps1", ".msi", ".com", ".scr",
    ".js", ".mjs", ".cjs", ".vbs", ".jar", ".php", ".phtml", ".py",
    ".rb", ".pl", ".dll", ".so", ".app", ".apk", ".htaccess", ".html", ".htm"
];

// Убираем из имени файла всё, что могло бы вывести путь за пределы
// целевой папки (../, абсолютные пути, разделители директорий и т.д.)
function sanitizeFilename(name) {
    if (!name) return "file";
    let base = path.basename(String(name)); // отбрасывает любые директории из пути
    base = base.replace(/[^a-zA-Z0-9а-яА-Я0-9_.\-]/g, "_"); // только безопасные символы
    if (!base || base === "." || base === "..") base = "file";
    return base.slice(0, 150);
}

function handleUpload(ws, msg, folder, type) {
    if (msg.data && msg.data.length > 10 * 1024 * 1024) {
        ws.send(JSON.stringify({ type: "error", text: "Файл слишком большой (макс 10MB)" }));
        return;
    }
    const safeOriginalName = sanitizeFilename(msg.filename || "video.webm");
    const ext = path.extname(safeOriginalName).toLowerCase();
    if (folder === "files" && DANGEROUS_EXTENSIONS.includes(ext)) {
        ws.send(JSON.stringify({ type: "error", text: "Этот тип файла запрещён к загрузке из соображений безопасности" }));
        return;
    }
    const filename = Date.now() + "_" + sanitizeFilename(ws.nick) + "_" + safeOriginalName;
    const filepath = path.join(folder, filename);
    // Доп. проверка: итоговый путь должен остаться строго внутри целевой папки
    if (!path.resolve(filepath).startsWith(path.resolve(folder) + path.sep)) {
        ws.send(JSON.stringify({ type: "error", text: "Недопустимое имя файла" }));
        return;
    }
    try {
        fs.writeFileSync(filepath, Buffer.from(msg.data, "base64"));
        ws.send(JSON.stringify({ type: type, url: `/${folder}/${filename}`, filename: msg.filename || filename }));
    } catch(e) {
        ws.send(JSON.stringify({ type: "error", text: "Ошибка сохранения файла" }));
    }
}

// ============================================================
// ПЛАНИРОВЩИК
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
            const chatId = msg.chatId;
            const from = msg.from;
            const text = msg.text;
            
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
        scheduledMessages = scheduledMessages.filter(m => !m.sent);
        saveScheduled();
    }
}

setInterval(checkScheduledMessages, 10000);

// ============================================================
// ПЕРЕВОД
// ============================================================

function translateText(text, targetLang) {
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
    let result = text;
    for (const [key, value] of Object.entries(langMap)) {
        if (lower.includes(key)) {
            result = result.replace(new RegExp(key, "gi"), value);
        }
    }
    if (result === text) {
        return `[Перевод на ${targetLang}] ${text}`;
    }
    return result;
}

// ============================================================
// ВЕБСОКЕТ
// ============================================================

wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => ws.isAlive = true);
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
                kickExistingSession(nick);
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
                password: hashPasswordSecure(password),
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
            if (!verifyPassword(password, usersDB[nick].password)) {
                ws.send(JSON.stringify({ type: "error", text: "Неверный пароль" }));
                recordIPAttempt(ip);
                return;
            }
            // Автоапгрейд: если пароль был в старом слабом формате (sha256 без
            // соли), после успешного входа тихо перехешируем на scrypt+соль
            if (!usersDB[nick].password.startsWith("scrypt:")) {
                usersDB[nick].password = hashPasswordSecure(password);
                saveUsers();
            }
            kickExistingSession(nick);
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

        // ===== PUSH-ПОДПИСКА =====
        if (msg.type === "push_subscribe") {
            if (!msg.subscription || !msg.subscription.endpoint) return;
            if (!pushSubscriptions[currentUser]) pushSubscriptions[currentUser] = [];
            const exists = pushSubscriptions[currentUser].some(s => s.endpoint === msg.subscription.endpoint);
            if (!exists) {
                pushSubscriptions[currentUser].push(msg.subscription);
                savePushSubscriptions();
            }
            return;
        }

        if (msg.type === "push_unsubscribe") {
            if (pushSubscriptions[currentUser]) {
                pushSubscriptions[currentUser] = pushSubscriptions[currentUser].filter(s => s.endpoint !== msg.endpoint);
                savePushSubscriptions();
            }
            return;
        }

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

        // ============================================================
        // ГРУППЫ — НОВЫЕ ОБРАБОТЧИКИ
        // ============================================================

        // Создать группу
        if (msg.type === "create_group") {
            if (!msg.name || !msg.name.trim()) {
                ws.send(JSON.stringify({ type: "error", text: "Введите название группы" }));
                return;
            }
            const groupId = createGroup(msg.name, currentUser);
            ws.send(JSON.stringify({ type: "group_created", group: groups[groupId] }));
            broadcast({ type: "group_update", group: groups[groupId] });
            return;
        }

        // Получить информацию о группе
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

        // Получить журнал действий
        if (msg.type === "get_group_log") {
            if (groups[msg.groupId] && groups[msg.groupId].members.includes(currentUser)) {
                ws.send(JSON.stringify({
                    type: "group_log",
                    groupId: msg.groupId,
                    log: getGroupLog(msg.groupId)
                }));
            }
            return;
        }

        // Назначить администратора
        if (msg.type === "add_admin") {
            if (addAdmin(msg.groupId, msg.nick, currentUser)) {
                ws.send(JSON.stringify({ type: "admin_added", groupId: msg.groupId, nick: msg.nick }));
            }
            return;
        }

        // Снять администратора
        if (msg.type === "remove_admin") {
            if (removeAdmin(msg.groupId, msg.nick, currentUser)) {
                ws.send(JSON.stringify({ type: "admin_removed", groupId: msg.groupId, nick: msg.nick }));
            }
            return;
        }

        // Добавить участника по нику
        if (msg.type === "add_member") {
            if (!nickExistsInDB(msg.nick)) {
                ws.send(JSON.stringify({ type: "error", text: `Пользователь "${msg.nick}" не найден` }));
                return;
            }
            if (addMemberByNick(msg.groupId, msg.nick, currentUser)) {
                ws.send(JSON.stringify({ type: "member_added", groupId: msg.groupId, nick: msg.nick }));
            } else {
                ws.send(JSON.stringify({ type: "error", text: "Пользователь уже в группе или забанен" }));
            }
            return;
        }

        // Удалить участника
        if (msg.type === "remove_member") {
            if (removeFromGroup(msg.groupId, msg.nick, currentUser)) {
                ws.send(JSON.stringify({ type: "member_removed", groupId: msg.groupId, nick: msg.nick }));
            }
            return;
        }

        // Выйти из группы
        if (msg.type === "leave_group") {
            if (leaveGroup(msg.groupId, currentUser)) {
                ws.send(JSON.stringify({ type: "left_group", groupId: msg.groupId }));
            } else {
                ws.send(JSON.stringify({ type: "error", text: "Создатель не может выйти, только удалить группу" }));
            }
            return;
        }

        // Удалить группу
        if (msg.type === "delete_group") {
            if (deleteGroup(msg.groupId, currentUser)) {
                ws.send(JSON.stringify({ type: "group_deleted", groupId: msg.groupId }));
            }
            return;
        }

        // Обновить настройки группы
        if (msg.type === "update_group_settings") {
            if (updateGroupSettings(msg.groupId, msg.settings, currentUser)) {
                ws.send(JSON.stringify({ type: "settings_updated", groupId: msg.groupId }));
            }
            return;
        }

        // Обновить название группы
        if (msg.type === "update_group_name") {
            if (updateGroupName(msg.groupId, msg.newName, currentUser)) {
                ws.send(JSON.stringify({ type: "group_name_updated", groupId: msg.groupId }));
            } else {
                ws.send(JSON.stringify({ type: "error", text: "Не удалось изменить название группы" }));
            }
            return;
        }

        // Получить пригласительную ссылку
        if (msg.type === "get_invite_link") {
            if (groups[msg.groupId] && groups[msg.groupId].members.includes(currentUser)) {
                const link = getInviteLink(msg.groupId);
                ws.send(JSON.stringify({
                    type: "invite_link",
                    groupId: msg.groupId,
                    link: link
                }));
            }
            return;
        }

        // Присоединиться по ссылке
        if (msg.type === "join_by_link") {
            if (joinByInviteLink(msg.groupId, msg.token, currentUser)) {
                ws.send(JSON.stringify({ type: "joined_by_link", groupId: msg.groupId }));
                broadcast({ type: "group_update", group: groups[msg.groupId] });
            } else {
                ws.send(JSON.stringify({ type: "error", text: "Неверная ссылка или вы уже в группе" }));
            }
            return;
        }

        // Обновить аватар группы
        if (msg.type === "update_group_avatar") {
            if (updateGroupAvatar(msg.groupId, msg.avatar, currentUser)) {
                ws.send(JSON.stringify({ type: "group_avatar_updated", groupId: msg.groupId, avatar: msg.avatar }));
            }
            return;
        }

        // Обновить описание группы
        if (msg.type === "update_group_description") {
            if (updateGroupDescription(msg.groupId, msg.description, currentUser)) {
                ws.send(JSON.stringify({ type: "group_description_updated", groupId: msg.groupId }));
            }
            return;
        }

        // Поиск по сообщениям в группе
        if (msg.type === "search_group_messages") {
            if (groups[msg.groupId] && groups[msg.groupId].members.includes(currentUser)) {
                const results = searchGroupMessages(msg.groupId, msg.query);
                ws.send(JSON.stringify({
                    type: "search_results",
                    results: results,
                    groupId: msg.groupId
                }));
            }
            return;
        }

        // Получить медиа группы
        if (msg.type === "get_group_media") {
            if (groups[msg.groupId] && groups[msg.groupId].members.includes(currentUser)) {
                ws.send(JSON.stringify({
                    type: "group_media",
                    groupId: msg.groupId,
                    media: getGroupMedia(msg.groupId)
                }));
            }
            return;
        }

        // Получить файлы группы
        if (msg.type === "get_group_files") {
            if (groups[msg.groupId] && groups[msg.groupId].members.includes(currentUser)) {
                ws.send(JSON.stringify({
                    type: "group_files",
                    groupId: msg.groupId,
                    files: getGroupFiles(msg.groupId)
                }));
            }
            return;
        }

        // Получить ссылки из группы
        if (msg.type === "get_group_links") {
            if (groups[msg.groupId] && groups[msg.groupId].members.includes(currentUser)) {
                ws.send(JSON.stringify({
                    type: "group_links",
                    groupId: msg.groupId,
                    links: getGroupLinks(msg.groupId)
                }));
            }
            return;
        }

        // Настройки уведомлений в группе
        if (msg.type === "set_group_notifications") {
            if (setGroupNotificationSettings(msg.groupId, currentUser, msg.settings)) {
                ws.send(JSON.stringify({ type: "notifications_set", groupId: msg.groupId }));
            }
            return;
        }

        // Получить настройки уведомлений
        if (msg.type === "get_group_notifications") {
            if (groups[msg.groupId] && groups[msg.groupId].members.includes(currentUser)) {
                const settings = getGroupNotificationSettings(msg.groupId, currentUser);
                ws.send(JSON.stringify({
                    type: "group_notifications",
                    groupId: msg.groupId,
                    settings: settings
                }));
            }
            return;
        }

        // Закрепить сообщение в группе
        if (msg.type === "pin_group_message") {
            if (pinGroupMessage(msg.groupId, msg.msgId, currentUser)) {
                ws.send(JSON.stringify({ type: "pin_success", groupId: msg.groupId, msgId: msg.msgId }));
            }
            return;
        }

        // Открепить сообщение в группе
        if (msg.type === "unpin_group_message") {
            if (unpinGroupMessage(msg.groupId, msg.msgId, currentUser)) {
                ws.send(JSON.stringify({ type: "unpin_success", groupId: msg.groupId, msgId: msg.msgId }));
            }
            return;
        }

        // Закрепить/открепить в публичном или личном чате
        if (msg.type === "pin_message") {
            const pin = pinMessage(msg.chatType || (msg.chatId === "public" ? "public" : "private"), msg.chatId, msg.msgId, currentUser);
            if (pin) ws.send(JSON.stringify({ type: "pin_success", id: msg.msgId }));
            else ws.send(JSON.stringify({ type: "error", text: "Не удалось закрепить сообщение" }));
            return;
        }

        if (msg.type === "unpin_message") {
            const chatType = msg.chatType || (msg.chatId === "public" ? "public" : "private");
            if (unpinMessage(chatType, msg.chatId, msg.msgId, currentUser)) {
                ws.send(JSON.stringify({ type: "unpin_success", id: msg.msgId }));
            }
            return;
        }

        // Получить закреплённые сообщения конкретного личного чата
        if (msg.type === "get_private_pinned") {
            ws.send(JSON.stringify({
                type: "private_pinned_list",
                chatId: msg.chatId,
                messages: privatePinned[msg.chatId] || []
            }));
            return;
        }

        // ============================================================
        // КАНАЛЫ
        // ============================================================

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

        // ===== КАНАЛЫ: АВАТАР / НАЗВАНИЕ / ОПИСАНИЕ =====
        if (msg.type === "update_channel_avatar") {
            if (updateChannelAvatar(msg.channelId, msg.avatar, currentUser)) {
                ws.send(JSON.stringify({ type: "channel_avatar_updated", channelId: msg.channelId }));
            }
            return;
        }

        if (msg.type === "update_channel_name") {
            if (updateChannelName(msg.channelId, msg.newName, currentUser)) {
                ws.send(JSON.stringify({ type: "channel_name_updated", channelId: msg.channelId }));
            } else {
                ws.send(JSON.stringify({ type: "error", text: "Не удалось изменить название канала" }));
            }
            return;
        }

        if (msg.type === "update_channel_description") {
            if (updateChannelDescription(msg.channelId, msg.description, currentUser)) {
                ws.send(JSON.stringify({ type: "channel_description_updated", channelId: msg.channelId }));
            }
            return;
        }

        // ===== КАНАЛЫ: АДМИНЫ КАНАЛА / АДМИНЫ КОММЕНТАРИЕВ (отдельно) =====
        if (msg.type === "add_channel_admin") {
            if (addChannelAdmin(msg.channelId, msg.nick, currentUser)) {
                ws.send(JSON.stringify({ type: "channel_admin_added", channelId: msg.channelId, nick: msg.nick }));
            }
            return;
        }

        if (msg.type === "remove_channel_admin") {
            if (removeChannelAdmin(msg.channelId, msg.nick, currentUser)) {
                ws.send(JSON.stringify({ type: "channel_admin_removed", channelId: msg.channelId, nick: msg.nick }));
            }
            return;
        }

        if (msg.type === "add_comment_admin") {
            if (addCommentAdmin(msg.channelId, msg.nick, currentUser)) {
                ws.send(JSON.stringify({ type: "comment_admin_added", channelId: msg.channelId, nick: msg.nick }));
            }
            return;
        }

        if (msg.type === "remove_comment_admin") {
            if (removeCommentAdmin(msg.channelId, msg.nick, currentUser)) {
                ws.send(JSON.stringify({ type: "comment_admin_removed", channelId: msg.channelId, nick: msg.nick }));
            }
            return;
        }

        // ===== КАНАЛЫ: КОММЕНТАРИИ К ПОСТАМ =====
        if (msg.type === "add_channel_comment") {
            if (!checkRate(ws)) {
                ws.send(JSON.stringify({ type: "error", text: "Слишком много сообщений" }));
                return;
            }
            const comment = addChannelComment(msg.channelId, msg.msgId, currentUser, msg.text);
            if (!comment) {
                ws.send(JSON.stringify({ type: "error", text: "Не удалось отправить комментарий" }));
            }
            return;
        }

        if (msg.type === "delete_channel_comment") {
            if (deleteChannelComment(msg.channelId, msg.msgId, msg.commentId, currentUser)) {
                ws.send(JSON.stringify({ type: "comment_delete_success", commentId: msg.commentId }));
            }
            return;
        }

        // ============================================================
        // СООБЩЕНИЯ В ГРУППАХ
        // ============================================================

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

        if (msg.type === "get_my_groups") {
            ws.send(JSON.stringify({
                type: "my_groups",
                groups: Object.values(groups).filter(g => g.members.includes(currentUser))
            }));
            return;
        }

        // ============================================================
        // ОПРОСЫ В ГРУППАХ
        // ============================================================

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

        // ============================================================
        // ПУБЛИЧНЫЙ ЧАТ
        // ============================================================

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
                forwardedFrom: msg.forwardedFrom || null,
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

        // ============================================================
        // ЛИЧНЫЙ ЧАТ
        // ============================================================

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
                forwardedFrom: msg.forwardedFrom || null,
                edited: false,
                chatId: `private_${msg.target}`
            };
            privateHistory[key].push(m);
            if (privateHistory[key].length > 500) privateHistory[key] = privateHistory[key].slice(-500);
            savePrivate();
            updateLastChat(currentUser, "private", msg.target, m.text || "📎 Вложение");
            updateLastChat(msg.target, "private", currentUser, m.text || "📎 Вложение");
            sendToUser(currentUser, { type: "private_msg", data: m, with: msg.target });
            if (msg.target !== currentUser) {
                const delivered = sendToUser(msg.target, { type: "private_msg", data: m, with: currentUser });
                if (!delivered) sendPushToUser(msg.target, { title: currentUser, body: m.text || "📎 Вложение", tag: `private_${currentUser}` });
            }
            return;
        }

        // ============================================================
        // РЕДАКТИРОВАНИЕ И УДАЛЕНИЕ
        // ============================================================

        if (msg.type === "edit") {
            if (editMessage(msg.chatType, msg.chatId, msg.id, msg.text, currentUser)) {
                ws.send(JSON.stringify({ type: "edit_success", id: msg.id }));
            }
            return;
        }

        if (msg.type === "delete") {
            if (deleteMessage(msg.chatType, msg.chatId, msg.id, currentUser)) {
                ws.send(JSON.stringify({ type: "delete_success", id: msg.id }));
            }
            return;
        }

        // ============================================================
        // ПЛАНИРОВЩИК
        // ============================================================

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

        // ============================================================
        // ПЕРЕВОД
        // ============================================================

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

        // ============================================================
        // ПРОЧИТАНО И РЕАКЦИИ
        // ============================================================

        if (msg.type === "mark_read") {
            markAsRead(msg.chatType, msg.chatId, msg.msgId, currentUser);
            return;
        }

        if (msg.type === "reaction") {
            updateReaction(msg.chatType, msg.id, currentUser, msg.reaction, msg.remove);
            return;
        }

        // ============================================================
        // ПЕЧАТАЕТ
        // ============================================================

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

        // ============================================================
        // ИСТОРИЯ
        // ============================================================

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

        // ============================================================
        // ЗАГРУЗКА ФАЙЛОВ
        // ============================================================

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

        // ============================================================
        // WEBRTC ЗВОНКИ (личные и групповые — mesh со стороны клиента)
        // ============================================================
        //
        // Клиент присылает сюда: offer / answer / ice — для установления
        // и обмена медиапотоками, а также hangup / call_busy / call_reject
        // для корректного завершения звонка на обеих сторонах (иначе
        // собеседник "зависает" в режиме дозвона, если вторая сторона
        // не ответила, отклонила или уже говорит по другому звонку).
        //
        // Все эти типы — это просто сигналинг: сервер ничего не решает
        // сам, только пересылает сообщение конкретному пользователю
        // (msg.to), сохраняя from = тот, кто прислал сообщение.
        // Сам голос/видео идёт напрямую между браузерами (P2P) либо
        // через TURN-сервер, если он настроен на клиенте.

        if (
            msg.type === "offer" ||
            msg.type === "answer" ||
            msg.type === "ice" ||
            msg.type === "hangup" ||
            msg.type === "call_busy" ||
            msg.type === "call_reject"
        ) {
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
                    video: msg.video || false,
                    groupCall: msg.groupCall || false,
                    groupId: msg.groupId || null
                }));
            } else {
                // Собеседник не в сети / отключился — сообщаем звонящему сразу,
                // чтобы интерфейс не завис в состоянии "дозвон"
                if (msg.type === "offer") {
                    ws.send(JSON.stringify({ type: "call_busy", from: msg.to }));
                }
            }
            return;
        }

        // ============================================================
        // ГЛОБАЛЬНЫЙ ПОИСК ПО ТЕКСТУ СООБЩЕНИЙ (во всех своих чатах разом)
        // ============================================================
        if (msg.type === "global_search") {
            const q = (msg.query || "").toLowerCase().trim();
            if (!q || q.length < 2) {
                ws.send(JSON.stringify({ type: "global_search_results", results: [] }));
                return;
            }
            const results = [];

            history.forEach(m => {
                if (m.text && m.text.toLowerCase().includes(q)) {
                    results.push({ chatType: "public", chatId: "public", chatName: "Общий чат", from: m.owner, text: m.text, time: m.time, msgId: m.id });
                }
            });

            for (const key in privateHistory) {
                privateHistory[key].forEach(m => {
                    if (m.from !== currentUser && m.to !== currentUser) return;
                    if (m.text && m.text.toLowerCase().includes(q)) {
                        const otherNick = m.from === currentUser ? m.to : m.from;
                        results.push({ chatType: "private", chatId: otherNick, chatName: otherNick, from: m.from, text: m.text, time: m.time, msgId: m.id });
                    }
                });
            }

            for (const gid in groups) {
                if (!groups[gid].members.includes(currentUser)) continue;
                groups[gid].messages.forEach(m => {
                    if (m.text && m.text.toLowerCase().includes(q)) {
                        results.push({ chatType: "group", chatId: gid, chatName: groups[gid].name, from: m.from, text: m.text, time: m.time, msgId: m.id });
                    }
                });
            }

            for (const cid in channels) {
                if (!channels[cid].subscribers.includes(currentUser)) continue;
                channels[cid].messages.forEach(m => {
                    if (m.text && m.text.toLowerCase().includes(q)) {
                        results.push({ chatType: "channel", chatId: cid, chatName: channels[cid].name, from: m.from, text: m.text, time: m.time, msgId: m.id });
                    }
                });
            }

            results.sort((a, b) => b.time - a.time);
            ws.send(JSON.stringify({ type: "global_search_results", results: results.slice(0, 100) }));
            return;
        }

        // БЛОКИРОВКА
        // ============================================================

        if (msg.type === "block_user") {
            if (!userBlocks.has(currentUser)) userBlocks.set(currentUser, []);
            if (!userBlocks.get(currentUser).includes(msg.target)) {
                userBlocks.get(currentUser).push(msg.target);
                saveBlocks();
                ws.send(JSON.stringify({ type: "block_success", target: msg.target }));
            }
            return;
        }

        if (msg.type === "unblock_user") {
            if (userBlocks.has(currentUser)) {
                userBlocks.set(currentUser, userBlocks.get(currentUser).filter(b => b !== msg.target));
                saveBlocks();
                ws.send(JSON.stringify({ type: "unblock_success", target: msg.target }));
            }
            return;
        }

        if (msg.type === "get_blocked_users") {
            ws.send(JSON.stringify({ type: "blocked_users", list: userBlocks.get(currentUser) || [] }));
            return;
        }

        // ============================================================
        // РЕПУТАЦИЯ
        // ============================================================

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
            // Если пользователь был в звонке, уведомляем всех, кому он мог
            // звонить/отвечать — иначе собеседник останется висеть в звонке
            broadcast({ type: "hangup", from: ws.nick, disconnected: true });
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
