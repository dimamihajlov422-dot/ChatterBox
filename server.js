const express = require("express")
const http = require("http")
const { Server } = require("socket.io")
const { Low } = require("lowdb")
const { JSONFile } = require("lowdb/node")
const path = require("path")

const app = express()
const server = http.createServer(app)
const io = new Server(server)

app.use(express.static("public"))
app.use(express.json())

// генератор ID
function id(len = 6) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let r = ""
  for (let i = 0; i < len; i++) {
    r += chars[Math.floor(Math.random() * chars.length)]
  }
  return r
}

// база
const file = path.join(__dirname, "db.json")
const adapter = new JSONFile(file)
const db = new Low(adapter, { chats: {} })

async function init() {
  await db.read()
  db.data ||= { chats: {} }
  await db.write()
}
init()

io.on("connection", socket => {

  socket.on("join", async ({nick, friend}) => {

    const chatId = [nick, friend].sort().join("|")

    socket.join(chatId)

    await db.read()

    if(!db.data.chats[chatId])
      db.data.chats[chatId] = []

    socket.emit("history", db.data.chats[chatId])
  })

  socket.on("message", async ({nick, friend, text}) => {

    const chatId = [nick, friend].sort().join("|")

    const msg = {
      from: nick,
      text,
      time: Date.now()
    }

    await db.read()

    if(!db.data.chats[chatId])
      db.data.chats[chatId] = []

    db.data.chats[chatId].push(msg)

    await db.write()

    io.to(chatId).emit("message", msg)

  })

})

server.listen(3000, () =>
  console.log("server started")
)