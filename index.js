
import "dotenv/config";
import http from "http";
import fs from "fs";
import pino from "pino";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import { GoogleGenAI } from "@google/genai";

/* =============== CONFIGURATION =============== */

const PORT = Number(process.env.PORT || 3000);
const BOT_NAME = process.env.BOT_NAME || "Piyas AI Bot";
const PREFIX = process.env.PREFIX || "/";
const AI_MODEL = process.env.AI_MODEL || "gemini-2.5-flash-lite";
const AUTH_DIR = "./auth_info";

const PHONE_NUMBER = String(process.env.PHONE_NUMBER || "")
  .replace(/\D/g, "")
  .replace(/^0/, "880");

const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || "").trim();

const logger = pino({ level: "silent" });

if (!PHONE_NUMBER || !GEMINI_API_KEY) {
  console.error("ERROR: Set PHONE_NUMBER and GEMINI_API_KEY.");
  process.exit(1);
}

const geminiAI = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

/* =============== HTTP SERVER =============== */

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

const SYSTEM_PROMPT = `
You are ${BOT_NAME}, a helpful WhatsApp AI assistant.

Reply in the same language as the user.
Reply in Bengali when the user writes Bengali.
Help with questions, education, mathematics, translation,
programming, social media posts, captions, stories, poems,
and original song lyrics.
Be respectful, clear, and helpful.
Do not claim to perform actions you did not perform.
Do not reproduce copyrighted song lyrics on request.
`;

async function askAI(prompt) {
  const result = await geminiAI.models.generateContent({
    model: AI_MODEL,
    contents: prompt,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.7,
      maxOutputTokens: 1500
    }
  });

  const answer = String(result?.text || "").trim();

  if (!answer) {
    throw new Error("Gemini returned an empty response.");
  }

  return answer;
}

/* =============== BOT STATE =============== */

let activeSocket = null;
let starting = false;
let shuttingDown = false;
let reconnectTimer = null;
let pairingRequested = false;

/* =============== RECONNECTION =============== */

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startBot();
  }, 5000);
}

/* =============== START WHATSAPP =============== */

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
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    activeSocket = sock;
    sock.ev.on("creds.update", saveCreds);

    /* =============== CONNECTION EVENTS =============== */

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "connecting") {
        console.log("Connecting to WhatsApp...");
      }

      if (connection === "open") {
        console.log(`${BOT_NAME} connected successfully!`);
        console.log(`AI model: ${AI_MODEL}`);
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error
          ? new Boom(lastDisconnect.error).output?.statusCode
          : undefined;

        console.log(
          "WhatsApp connection closed. Status:",
          statusCode ?? "unknown"
        );

        if (activeSocket === sock) {
          activeSocket = null;
        }

        if (statusCode === DisconnectReason.loggedOut) {
          console.error(
            "WhatsApp logged out. Relink the account manually."
          );
          return;
        }

        console.log("Reconnecting in 5 seconds...");
        scheduleReconnect();
      }
    });

    /* =============== PAIRING CODE =============== */

    if (!state.creds.registered && !pairingRequested) {
      pairingRequested = true;

      void (async () => {
        try {
          await new Promise(resolve => setTimeout(resolve, 3000));

          if (shuttingDown || activeSocket !== sock) return;
          if (state.creds.registered) return;

          const code = await sock.requestPairingCode(PHONE_NUMBER);

          console.log("\n==============================");
          console.log("WHATSAPP PAIRING CODE");
          console.log(code);
          console.log("==============================");
          console.log("WhatsApp > Linked Devices");
          console.log("Link a device > Link with phone number");
          console.log("Enter the code above.");
          console.log("==============================\n");
        } catch (error) {
          console.error(
            "Pairing error:",
            error?.message || "Unknown error"
          );
        }
      })();
    }

    /* =============== MESSAGE HANDLER =============== */

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      if (activeSocket !== sock) return;

      for (const msg of messages) {
        try {
          if (!msg?.message || msg.key?.fromMe) continue;

          const jid = msg.key?.remoteJid;

          if (!jid || jid === "status@broadcast") continue;
          if (jid.endsWith("@newsletter")) continue;

          let message = msg.message;

          while (
            message?.ephemeralMessage?.message ||
            message?.viewOnceMessage?.message ||
            message?.viewOnceMessageV2?.message ||
            message?.documentWithCaptionMessage?.message
          ) {
            message =
              message.ephemeralMessage?.message ||
              message.viewOnceMessage?.message ||
              message.viewOnceMessageV2?.message ||
              message.documentWithCaptionMessage?.message;
          }

          const rawText =
            message.conversation ||
            message.extendedTextMessage?.text ||
            message.imageMessage?.caption ||
            message.videoMessage?.caption ||
            message.documentMessage?.caption ||
            "";

          const text = String(rawText).trim();

          if (!text) continue;

          const lowerText = text.toLowerCase();
          const aiCommand = `${PREFIX}ai`;
          const askCommand = `${PREFIX}ask`;

          const isAICommand =
            lowerText === aiCommand.toLowerCase() ||
            lowerText.startsWith(
              `${aiCommand} `.toLowerCase()
            );

          const isAskCommand =
            lowerText === askCommand.toLowerCase() ||
            lowerText.startsWith(
              `${askCommand} `.toLowerCase()
            );

          // Ignore every message that does not use an AI command.
          if (!isAICommand && !isAskCommand) continue;

          const command = isAICommand ? aiCommand : askCommand;
          const prompt = text.slice(command.length).trim();

          if (!prompt) {
            await sock.sendMessage(
              jid,
              {
                text:
                  `প্রশ্ন লিখো।\n\n` +
                  `উদাহরণ: ${PREFIX}ai তুমি কে?\n` +
                  `অথবা: ${PREFIX}ask বাংলাদেশের রাজধানী কী?`
              },
              { quoted: msg }
            );
            continue;
          }

          console.log(`[AI REQUEST] ${jid}`);
          await sock.sendPresenceUpdate("composing", jid);

          let answer;

          try {
            answer = await askAI(prompt);
          } catch (error) {
            console.error(
              "[GEMINI ERROR]",
              error?.message || "Unknown error"
            );

            answer =
              "দুঃখিত, AI সেবা এখন কাজ করছে না। " +
              "কিছুক্ষণ পরে আবার চেষ্টা করো।";
          }

          if (activeSocket !== sock) continue;

          await sock.sendMessage(
            jid,
            { text: String(answer).slice(0, 12000) },
            { quoted: msg }
          );

          await sock.sendPresenceUpdate("paused", jid);
          console.log(`[AI REPLIED] ${jid}`);

        } catch (error) {
          console.error(
            "[MESSAGE HANDLER ERROR]",
            error?.message || error
          );
        }
      }
    });

  } catch (error) {
    console.error(
      "Bot startup error:",
      error?.message || error
    );
    scheduleReconnect();
  } finally {
    starting = false;
  }
}

/* =============== SHUTDOWN =============== */

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;
  console.log(`Received ${signal}. Shutting down...`);

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
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

process.on("unhandledRejection", (error) => {
  console.error(
    "Unhandled rejection:",
    error?.message || error
  );
});

/* =============== RUN =============== */

console.log(`Starting ${BOT_NAME}...`);
console.log(`AI model: ${AI_MODEL}`);

void startBot();

