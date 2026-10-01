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

const PHONE_NUMBER = String(process.env.PHONE_NUMBER || "")
  .replace(/\D/g, "")
  .replace(/^0/, "880");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const AUTH_DIR = "./auth_info";

const logger = pino({ level: "silent" });

/* =============== VALIDATION =============== */

if (!PHONE_NUMBER) {
  console.error("ERROR: PHONE_NUMBER is missing.");
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY is missing.");
  process.exit(1);
}

if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

/* =============== GEMINI AI =============== */

const geminiAI = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

const SYSTEM_PROMPT = `
You are ${BOT_NAME}, a helpful WhatsApp AI assistant.

Respond in the same language as the user's message.
Be polite, clear, and useful.
Help with questions, explanations, coding, captions, social media posts,
stories, poems, original song lyrics, translations, and brainstorming.
For coding requests, provide complete and valid code when appropriate.
Never claim that you performed an action you did not perform.
If you do not know an answer, say so honestly.
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

  const answer = result.text;

  if (!answer || !answer.trim()) {
    return "দুঃখিত, AI থেকে কোনো উত্তর পাওয়া যায়নি। আবার চেষ্টা করো।";
  }

  return answer.trim();
}

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

/* =============== BOT STATE =============== */

let activeSocket = null;
let starting = false;
let reconnectTimer = null;
let pairingRequested = false;
let shuttingDown = false;
let connectionOpen = false;

/* =============== CONNECTION WAIT =============== */

function waitForWhatsAppConnection(sock, timeoutMs = 300000) {
  return new Promise((resolve) => {
    let finished = false;

    const finish = (connected) => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);
      sock.ev.off("connection.update", onUpdate);
      resolve(connected);
    };

    const onUpdate = (update) => {
      if (update.connection === "open") {
        finish(true);
      } else if (update.connection === "close") {
        finish(false);
      }
    };

    if (connectionOpen && activeSocket === sock) {
      resolve(true);
      return;
    }

    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);

    sock.ev.on("connection.update", onUpdate);
  });
}

/* =============== RECONNECT =============== */

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot();
  }, 5000);
}

/* =============== START BOT =============== */

async function startBot() {
  if (starting || shuttingDown) return;

  starting = true;

  try {
    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.ubuntu(BOT_NAME),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    activeSocket = sock;
    connectionOpen = false;

    sock.ev.on("creds.update", saveCreds);

    /* =============== CONNECTION EVENTS =============== */

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "connecting") {
        console.log("Connecting to WhatsApp...");
      }

      if (connection === "open") {
        connectionOpen = true;
        console.log(`${BOT_NAME} connected successfully!`);
      }

      if (connection === "close") {
        connectionOpen = false;

        const statusCode = new Boom(
          lastDisconnect?.error
        ).output?.statusCode;

        console.log(
          "WhatsApp connection closed. Status:",
          statusCode ?? "unknown"
        );

        if (activeSocket === sock) {
          activeSocket = null;
        }

        if (statusCode === DisconnectReason.loggedOut) {
          console.log(
            "Session logged out. Re-link WhatsApp before restarting."
          );
          return;
        }

        scheduleReconnect();
      }
    });

    /* =============== PAIRING CODE =============== */

    if (!state.creds.registered && !pairingRequested) {
      pairingRequested = true;

      (async () => {
        try {
          console.log("Waiting for WhatsApp socket initialization...");
          await new Promise((resolve) => setTimeout(resolve, 3000));

          if (shuttingDown || activeSocket !== sock) return;

          if (state.creds.registered) {
            console.log("WhatsApp is already registered.");
            return;
          }

          const connectionWait = waitForWhatsAppConnection(
            sock,
            5 * 60 * 1000
          );

          const code = await sock.requestPairingCode(PHONE_NUMBER);

          console.log("\n================================");
          console.log("WHATSAPP PAIRING CODE");
          console.log("================================");
          console.log(code);
          console.log("================================");
          console.log("Open WhatsApp > Linked Devices");
          console.log("Choose Link a device > Link with phone number");
          console.log("Enter the code displayed above.");
          console.log("Waiting up to 5 minutes for connection...");
          console.log("================================\n");

          const connected = await connectionWait;

          if (connected) {
            console.log("WhatsApp linked successfully!");
          } else {
            console.log(
              "Connection did not complete within the waiting period, " +
              "or WhatsApp disconnected. Check the logs."
            );
          }
        } catch (error) {
          console.error(
            "Pairing failed:",
            error?.message || error
          );
        }
      })();
    }

    /* =============== MESSAGE HANDLER =============== */

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          if (msg.key.fromMe) continue;

          const jid = msg.key.remoteJid;

          if (!jid || jid === "status@broadcast") continue;
          if (jid.endsWith("@newsletter")) continue;

          const message = msg.message;

          const textMessage =
            message.conversation ||
            message.extendedTextMessage?.text ||
            message.imageMessage?.caption ||
            message.videoMessage?.caption ||
            message.documentMessage?.caption ||
            "";

          const text = textMessage.trim();

          if (!text) continue;

          const commandText = text.toLowerCase();

          /* Help command */

          if (
            commandText === `${PREFIX}menu` ||
            commandText === `${PREFIX}help`
          ) {
            const menu = [
              `🤖 *${BOT_NAME}*`,
              "",
              `${PREFIX}ai <question> - Ask AI`,
              `${PREFIX}ask <question> - Ask AI`,
              `${PREFIX}help - Show this menu`,
              "",
              "You can also send a normal text message to chat with AI."
            ].join("\n");

            await sock.sendMessage(
              jid,
              { text: menu },
              { quoted: msg }
            );

            continue;
          }

          /* AI commands */

          let prompt = text;

          if (text.startsWith(`${PREFIX}ai `)) {
            prompt = text.slice(`${PREFIX}ai `.length).trim();
          } else if (text.startsWith(`${PREFIX}ask `)) {
            prompt = text.slice(`${PREFIX}ask `.length).trim();
          } else if (
            text === `${PREFIX}ai` ||
            text === `${PREFIX}ask`
          ) {
            await sock.sendMessage(
              jid,
              {
                text: `প্রশ্ন লিখো। উদাহরণ: ${PREFIX}ai বাংলাদেশের রাজধানী কী?`
              },
              { quoted: msg }
            );

            continue;
          }

          if (!prompt) continue;

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

          try {
            await sock.sendMessage(
              msg.key.remoteJid,
              {
                text: "দুঃখিত, এই মুহূর্তে উত্তর দিতে সমস্যা হচ্ছে। একটু পরে আবার চেষ্টা করো।"
              },
              { quoted: msg }
            );
          } catch {
            // The message may not be deliverable if WhatsApp disconnected.
          }
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
    }
  } catch (error) {
    console.error("Socket shutdown error:", error?.message || error);
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/* =============== RUN BOT =============== */

startBot();