
import "dotenv/config";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

import P from "pino";
import { Boom } from "@hapi/boom";
import { GoogleGenAI } from "@google/genai";
import http from "http";
import fs from "fs";

/* ================= CONFIGURATION ================= */

const PORT = Number(process.env.PORT || 3000);
const BOT_NAME = process.env.BOT_NAME || "Piyas AI Bot";
const PREFIX = process.env.PREFIX || "/";
const AI_MODEL = process.env.AI_MODEL || "gemini-2.5-flash-lite";
const AUTH_DIR = "./auth_info";

const PHONE_NUMBER = String(process.env.PHONE_NUMBER || "")
  .replace(/\D/g, "")
  .replace(/^0/, "880");

const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || "").trim();

if (!PHONE_NUMBER || !GEMINI_API_KEY) {
  console.error("Missing PHONE_NUMBER or GEMINI_API_KEY.");
  process.exit(1);
}

const geminiAI = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

const logger = P({ level: "silent" });

/* ================= HTTP SERVER ================= */

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end(`${BOT_NAME} is running.`);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP server running on port ${PORT}`);
});

/* ================= AI INSTRUCTIONS ================= */

const SYSTEM_INSTRUCTION = `
You are ${BOT_NAME}, a friendly WhatsApp AI assistant.

You can:
- Answer questions and have natural conversations.
- Write social media posts, captions and messages.
- Create original stories, poems and song lyrics.
- Help with education, mathematics and translations.
- Write and explain programming code.
- Help with technology and everyday tasks.

Reply in the language used by the user.
If the user writes Bengali, answer in Bengali.
Be friendly, respectful, clear and helpful.
Keep ordinary answers concise unless more detail is requested.
Create original song lyrics; do not reproduce copyrighted song lyrics
on request.
`;

async function askAI(prompt) {
  try {
    const result = await geminiAI.models.generateContent({
      model: AI_MODEL,
      contents: String(prompt),
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.7,
        maxOutputTokens: 1200
      }
    });

    const answer = String(result?.text || "").trim();

    return answer || "দুঃখিত, এবার উত্তর তৈরি করতে পারলাম না।";

  } catch (error) {
    console.error("Gemini error:", error?.message || error);

    return "AI সেবা এখন পাওয়া যাচ্ছে না। কিছুক্ষণ পর আবার চেষ্টা করো।";
  }
}

/* ================= CONNECTION STATE ================= */

let activeSocket = null;
let starting = false;
let reconnectTimer = null;
let pairingRequested = false;
let shuttingDown = false;

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot();
  }, 5000);
}

/* ================= START WHATSAPP ================= */

async function startBot() {
  if (starting || shuttingDown) return;

  starting = true;

  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    activeSocket = sock;

    sock.ev.on("creds.update", saveCreds);

    /* =============== CONNECTION UPDATES =============== */

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "connecting") {
        console.log("Connecting to WhatsApp...");
      }

      if (connection === "open") {
        console.log(`${BOT_NAME} connected successfully.`);
        console.log(`AI model: ${AI_MODEL}`);
        pairingRequested = false;
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error
          ? new Boom(lastDisconnect.error).output?.statusCode
          : undefined;

        console.error("WhatsApp connection closed.");
        console.error("Disconnect status:", statusCode ?? "unknown");

        activeSocket = null;

        if (statusCode === DisconnectReason.loggedOut) {
          console.error(
            "WhatsApp logged out. Check the number/session. " +
            "Do not delete auth_info unless you intend to pair again."
          );

          // Do not repeatedly generate pairing codes.
          // Stop here until the session is checked manually.
        } else {
          console.log("Retrying connection in 5 seconds...");
          scheduleReconnect();
        }
      }
    });

    /* =============== SINGLE PAIRING ATTEMPT =============== */

    if (!state.creds.registered && !pairingRequested) {
      pairingRequested = true;

      console.log("WhatsApp is not linked yet.");
      console.log("Requesting one pairing code...");

      // Allow the socket a moment to initialize.
      setTimeout(async () => {
        if (shuttingDown || activeSocket !== sock) return;

        try {
          if (state.creds.registered) return;

          const code = await sock.requestPairingCode(PHONE_NUMBER);

          console.log("\n================================");
          console.log("WHATSAPP PAIRING CODE");
          console.log("================================");
          console.log(code);
          console.log("================================");
          console.log(
            "On your phone: WhatsApp > Linked Devices > " +
            "Link a device > Link with phone number"
          );
          console.log("Enter the code shown above.");
          console.log("================================\n");

          console.log(
            "This process will not request another code automatically."
          );
        } catch (error) {
          console.error(
            "Pairing request failed:",
            error?.message || error
          );

          console.error(
            "Check the international phone number and connection logs."
          );

          // Intentionally do not create another code in a loop.
        }
      }, 3000);
    }

    /* ================= MESSAGE HANDLER ================= */

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          if (!msg?.message || msg.key?.fromMe) continue;

          const jid = msg.key?.remoteJid;

          if (!jid || jid === "status@broadcast") continue;

          const message = msg.message;

          let text =
            message.conversation ||
            message.extendedTextMessage?.text ||
            message.imageMessage?.caption ||
            message.videoMessage?.caption ||
            "";

          text = String(text).trim();

          if (!text) continue;

          let prompt = text;
          const lower = text.toLowerCase();

          const aiCommand = `${PREFIX}ai`.toLowerCase();
          const askCommand = `${PREFIX}ask`.toLowerCase();

          if (lower === aiCommand || lower === askCommand) {
            prompt = "হ্যালো! আমার সঙ্গে স্বাভাবিকভাবে কথা বলো।";
          } else if (lower.startsWith(aiCommand + " ")) {
            prompt = text.slice(aiCommand.length).trim();
          } else if (lower.startsWith(askCommand + " ")) {
            prompt = text.slice(askCommand.length).trim();
          }

          if (!prompt) continue;

          console.log(`Message received from ${jid}`);

          await sock.sendPresenceUpdate("composing", jid);

          const answer = await askAI(prompt);

          await sock.sendMessage(
            jid,
            { text: answer },
            { quoted: msg }
          );

          await sock.sendPresenceUpdate("paused", jid);

        } catch (error) {
          console.error(
            "Message handling error:",
            error?.message || error
          );
        }
      }
    });

  } catch (error) {
    console.error("Startup error:", error?.message || error);
    scheduleReconnect();
  } finally {
    starting = false;
  }
}

/* ================= SHUTDOWN ================= */

async function shutdown() {
  shuttingDown = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (activeSocket) {
      activeSocket.end(undefined);
    }
  } catch (error) {
    console.error("Shutdown error:", error?.message || error);
  }

  server.close(() => process.exit(0));

  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

console.log(`Starting ${BOT_NAME}...`);
console.log(`AI model: ${AI_MODEL}`);

startBot();
