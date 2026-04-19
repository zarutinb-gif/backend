import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import crypto from "crypto";
import pkg from "pg";
import { WebSocketServer } from "ws";

dotenv.config();
const { Pool } = pkg;

// ----------------------
// PostgreSQL
// ----------------------
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ----------------------
// Ожидание готовности БД
// ----------------------
async function waitForDB() {
  let connected = false;
  while (!connected) {
    try {
      await db.query("SELECT 1");
      connected = true;
      console.log("Database is ready");
    } catch (e) {
      console.log("DB not ready, retrying in 1s...");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ----------------------
// Автоматическое создание таблиц
// ----------------------
async function initTables() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        tg_id BIGINT UNIQUE,
        username TEXT,
        balance INTEGER DEFAULT 1000
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS games (
        id SERIAL PRIMARY KEY,
        crash_multiplier REAL,
        started_at TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS bets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        game_id INTEGER REFERENCES games(id),
        amount INTEGER,
        cashout_multiplier REAL
      );
    `);

    console.log("Tables initialized");
  } catch (e) {
    console.error("Table init error:", e);
  }
}

// ----------------------
// Telegram initData check
// ----------------------
function validateTelegramInitData(initData, botToken) {
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get("hash");
  urlParams.delete("hash");

  const dataCheckString = [...urlParams.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  return calculatedHash === hash;
}

// ----------------------
// Express API
// ----------------------
const app = express();
app.use(cors());
app.use(bodyParser.json());

const BOT_TOKEN = process.env.BOT_TOKEN;

// Авторизация WebApp
app.post("/auth/login", async (req, res) => {
  try {
    const { initData } = req.body;

    if (!validateTelegramInitData(initData, BOT_TOKEN)) {
      return res.status(403).json({ error: "Invalid initData" });
    }

    const data = Object.fromEntries(new URLSearchParams(initData));
    const user = JSON.parse(data.user);

    const tgId = user.id;
    const username = user.username || "unknown";

    let result = await db.query(
      "SELECT * FROM users WHERE tg_id = $1",
      [tgId]
    );

    if (result.rows.length === 0) {
      await db.query(
        "INSERT INTO users (tg_id, username, balance) VALUES ($1, $2, $3)",
        [tgId, username, 1000]
      );
      result = await db.query(
        "SELECT * FROM users WHERE tg_id = $1",
        [tgId]
      );
    }

    res.json({
      ok: true,
      user: {
        id: result.rows[0].id,
        tgId,
        username,
        balance: result.rows[0].balance,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// Получить баланс
app.get("/user/balance", async (req, res) => {
  try {
    const { tgId } = req.query;

    const result = await db.query(
      "SELECT balance FROM users WHERE tg_id = $1",
      [tgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ balance: result.rows[0].balance });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// История игр
app.get("/game/history", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, crash_multiplier, started_at FROM games ORDER BY id DESC LIMIT 20"
    );
    res.json({ games: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------------
// Crash Game Logic
// ----------------------
class CrashGame {
  constructor() {
    this.currentGame = null;
    this.multiplier = 1.0;
    this.interval = null;
    this.clients = new Set();
    this.state = "idle";
  }

  addClient(ws) {
    this.clients.add(ws);
    ws.send(JSON.stringify({
      type: "state",
      state: this.state,
      multiplier: this.multiplier,
    }));
  }

  removeClient(ws) {
    this.clients.delete(ws);
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === 1) client.send(data);
    }
  }

  async startGame() {
    if (this.state === "running") return;

    this.state = "running";
    this.multiplier = 1.0;

    const gameRes = await db.query(
      "INSERT INTO games (crash_multiplier, started_at) VALUES ($1, NOW()) RETURNING *",
      [0]
    );
    this.currentGame = gameRes.rows[0];

    this.broadcast({ type: "game_start", gameId: this.currentGame.id });

    this.interval = setInterval(async () => {
      this.multiplier += 0.05 + Math.random() * 0.1;

      this.broadcast({
        type: "tick",
        multiplier: Number(this.multiplier.toFixed(2)),
      });

      const crashAt = 1.2 + Math.random() * 4;

      if (this.multiplier >= crashAt) {
        this.state = "crashed";
        clearInterval(this.interval);

        await db.query(
          "UPDATE games SET crash_multiplier = $1, ended_at = NOW() WHERE id = $2",
          [this.multiplier, this.currentGame.id]
        );

        this.broadcast({
          type: "crash",
          multiplier: Number(this.multiplier.toFixed(2)),
        });

        setTimeout(() => {
          this.state = "idle";
          this.startGame();
        }, 3000);
      }
    }, 200);
  }
}

// ----------------------
// WebSocket Server
// ----------------------
async function startWebSocketServer() {
  const wsPort = process.env.WS_PORT || 4801;
  const wss = new WebSocketServer({ port: wsPort });
  const game = new CrashGame();

  console.log("WS server running on port", wsPort);

  await waitForDB();
  game.startGame();

  wss.on("connection", (ws) => {
    game.addClient(ws);

    ws.on("message", async (msg) => {
      try {
        const data = JSON.parse(msg.toString());

        if (data.type === "bet") {
          const { tgId, amount } = data;

          const userRes = await db.query(
            "SELECT id, balance FROM users WHERE tg_id = $1",
            [tgId]
          );
          if (userRes.rows.length === 0) return;

          const user = userRes.rows[0];
          if (user.balance < amount) return;

          await db.query(
            "UPDATE users SET balance = balance - $1 WHERE id = $2",
            [amount, user.id]
          );

          await db.query(
            "INSERT INTO bets (user_id, game_id, amount) VALUES ($1, $2, $3)",
            [user.id, game.currentGame.id, amount]
          );

          ws.send(JSON.stringify({ type: "bet_accepted", amount }));
        }

        if (data.type === "cashout") {
          const { tgId, multiplier } = data;

          const userRes = await db.query(
            "SELECT id FROM users WHERE tg_id = $1",
            [tgId]
          );
          if (userRes.rows.length === 0) return;

          const user = userRes.rows[0];

          const betRes = await db.query(
            "SELECT * FROM bets WHERE user_id = $1 AND game_id = $2 AND cashout_multiplier IS NULL",
            [user.id, game.currentGame.id]
          );
          if (betRes.rows.length === 0) return;

          const bet = betRes.rows[0];
          const winAmount = Math.floor(bet.amount * multiplier);

          await db.query(
            "UPDATE bets SET cashout_multiplier = $1 WHERE id = $2",
            [multiplier, bet.id]
          );

          await db.query(
            "UPDATE users SET balance = balance + $1 WHERE id = $2",
            [winAmount, user.id]
          );

          ws.send(JSON.stringify({
            type: "cashout_ok",
            winAmount,
            multiplier,
          }));
        }
      } catch (e) {
        console.error(e);
      }
    });

    ws.on("close", () => game.removeClient(ws));
  });
}

// ----------------------
// Start servers
// ----------------------
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("HTTP backend running on port", PORT);
});

(async () => {
  await initTables();
  startWebSocketServer();
})();
