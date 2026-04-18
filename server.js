import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import http from "http";

dotenv.config();

console.log("TOKEN:", process.env.BOT_TOKEN);

// Создаём бота
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

console.log("Bot is running...");

// Обработчик сообщений
bot.on("message", (msg) => {
  bot.sendMessage(msg.chat.id, "Запустить игру 🚀", {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Играть",
            web_app: { url: "https://rocketcrush.vercel.app" }
          }
        ]
      ]
    }
  });
});

// Render требует, чтобы сервер слушал порт
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.write("RocketCrush bot is running");
  res.end();
}).listen(PORT, () => {
  console.log("Server running on port", PORT);
});

