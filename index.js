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

/* =============== CONFIG =============== */

const PORT = Number(process.env.PORT || 3000);
const BOT_NAME = process.env.BOT_NAME || "Piyas AI Bot";
const PREFIX = process.env.PREFIX || "/";
const AI_MODEL =
  process.env.AI_MODEL || "gemini-3.5-flash-lite";
const PHONE_NUMBER = String(
  process.env.PHONE_NUMBER || ""
).replace(/\D/g, "").replace(/^0/, "880");

const API_KEY = String(
  process.env.GEMINI_API_KEY || ""
).trim();

const AUTH_DIR = "./auth_info";
const logger = P({ level: "silent" });

if (!API_KEY) {
  console.error("ERROR: GEMINI_API_KEY is missing!");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

/* =============== WEB SERVER =============== */

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end(`${BOT_NAME} is running.`);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`${BOT_NAME} server listening on port ${PORT}`);
});

/* =============== AI INSTRUCTIONS =============== */

const SYSTEM_INSTRUCTION = `
You are ${BOT_NAME}, a helpful WhatsApp AI assistant.

- Reply in the same language as the user's question.
- Understand and reply naturally in Bengali and English.
- Answer questions, explain topics, translate text,
  write posts, captions, stories, poems and original lyrics.
- Help with education, technology and programming.
- Be friendly, respectful and accurate.
- If unsure, clearly say so.
- Do not reproduce copyrighted song lyrics on request.
`;

/* =============== GEMINI AI =============== */

async function askAI(prompt) {
  const result = await ai.models.generateContent({
    model: AI_MODEL,
    contents: prompt,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      temperature: 0.7,
      maxOutputTokens: 1500
    }
  });

  return String(result?.text || "").trim();
}

/* =============== WHATSAPP STATE =============== */

let activeSocket = null;
let starting = false;
let reconnectTimer = null;
let shuttingDown = false;

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot();
  }, 5000);
}

/* =============== MESSAGE HANDLER =============== */

async function handleMessage(sock, msg) {
  if (!msg?.message || msg.key?.fromMe) return;

  const jid = msg.key?.remoteJid;

  if (!jid || jid === "status@broadcast") return;

  // Extract text from supported WhatsApp message types.
  const message = msg.message;
  const text = String(
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ""
  ).trim();

  if (!text) return;

  // IMPORTANT:
  // Ignore every message unless it starts with /ai.
  // This applies to groups and private chats.
  const command = `${PREFIX}ai`;
  const lowerText = text.toLowerCase();
  const lowerCommand = command.toLowerCase();

  if (
    lowerText !== lowerCommand &&
    !lowerText.startsWith(lowerCommand + " ")
  ) {
    return;
  }

  // Extract the question after /ai.
  const prompt = text.slice(command.length).trim();

  if (!prompt) {
    await sock.sendMessage(
      jid,
      {
        text: `🤖 ${BOT_NAME}\n\nপ্রশ্ন করতে লিখো:\n${command} তোমার প্রশ্ন\n\nউদাহরণ:\n${command} বাংলাদেশের রাজধানী কী?`
      },
      { quoted: msg }
    );
    return;
  }

  console.log(`[AI REQUEST] ${jid}: ${prompt}`);

  try {
    await sock.sendPresenceUpdate("composing", jid);

    const answer = await askAI(prompt);

    if (!answer) {
      throw new Error("Gemini returned an empty response.");
    }

    // Avoid sending a reply if this socket was replaced.
    if (activeSocket !== sock || shuttingDown) return;

    await sock.sendMessage(
      jid,
      { text: answer },
      { quoted: msg }
    );

    console.log(`[AI REPLIED] ${jid}`);

  } catch (error) {
    console.error(
      "[GEMINI ERROR]",
      error?.message || error
    );

    if (activeSocket === sock && !shuttingDown) {
      await sock.sendMessage(
        jid,
        {
          text:
            "দুঃখিত, AI উত্তর তৈরি করতে পারেনি। " +
            "কিছুক্ষণ পর আবার চেষ্টা করো।"
        },
        { quoted: msg }
      ).catch(() => {});
    }

  } finally {
    if (activeSocket === sock) {
      await sock.sendPresenceUpdate("paused", jid)
        .catch(() => {});
    }
  }
}

/* =============== START BOT =============== */

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

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "connecting") {
        console.log("Connecting to WhatsApp...");
      }

      if (connection === "open") {
        console.log(`${BOT_NAME} connected successfully!`);
        console.log(`AI model: ${AI_MODEL}`);
        console.log("AI replies only to /ai questions.");
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error
          ? new Boom(lastDisconnect.error).output?.statusCode
          : undefined;

        console.error(
          "WhatsApp connection closed:",
          statusCode ?? "unknown"
        );

        if (activeSocket === sock) {
          activeSocket = null;
        }

        if (
          statusCode === DisconnectReason.loggedOut
        ) {
          console.error(
            "WhatsApp logged out. Re-link the device."
          );
        } else {
          console.log("Reconnecting in 5 seconds...");
          scheduleReconnect();
        }
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        handleMessage(sock, msg).catch((error) => {
          console.error(
            "[MESSAGE ERROR]",
            error?.message || error
          );
        });
      }
    });

  } catch (error) {
    console.error(
      "[STARTUP ERROR]",
      error?.message || error
    );

    scheduleReconnect();

  } finally {
    starting = false;
  }
}

/* =============== SHUTDOWN =============== */

async function shutdown() {
  if (shuttingDown) return;

  shuttingDown = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (activeSocket) {
      activeSocket.end(undefined);
      activeSocket = null;
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
  console.error("[UNHANDLED]", error);
});

console.log(`Starting ${BOT_NAME}...`);
console.log(`AI model: ${AI_MODEL}`);

startBot();