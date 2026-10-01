import "dotenv/config";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import P from "pino";
import http from "http";
import fs from "fs";
import readline from "readline";
import { GoogleGenAI } from "@google/genai";

/* =========================================================
   CONFIGURATION
========================================================= */

const PORT = Number(process.env.PORT || 3000);

const PHONE_NUMBER = String(
  process.env.PHONE_NUMBER || ""
).replace(/[^0-9]/g, "");

const GEMINI_API_KEY = String(
  process.env.GEMINI_API_KEY || ""
).trim();

const AI_MODEL =
  process.env.AI_MODEL || "gemini-2.5-flash-lite";

const BOT_NAME =
  process.env.BOT_NAME || "Piyas AI Bot";

const PREFIX =
  process.env.PREFIX || "/";

const AUTH_DIR = "./auth_info";

/* =========================================================
   CHECK ENVIRONMENT VARIABLES
========================================================= */

if (!GEMINI_API_KEY) {
  console.error(
    "ERROR: GEMINI_API_KEY is missing."
  );
  process.exit(1);
}

if (!PHONE_NUMBER) {
  console.error(
    "ERROR: PHONE_NUMBER is missing."
  );
  process.exit(1);
}

/* =========================================================
   GEMINI AI
========================================================= */

const geminiAI = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

/* =========================================================
   AI SYSTEM INSTRUCTION
========================================================= */

const SYSTEM_INSTRUCTION = `
You are ${BOT_NAME}, a friendly and helpful AI assistant.

Your job is to talk naturally with people on WhatsApp.

Main abilities:

1. Answer general questions.
2. Have natural conversations.
3. Explain difficult topics simply.
4. Write Facebook, WhatsApp and Telegram posts.
5. Write captions.
6. Write romantic messages.
7. Write emotional messages.
8. Write birthday wishes.
9. Write promotional and business posts.
10. Write stories.
11. Write poems.
12. Create original song ideas and original lyrics.
13. Help with study and education.
14. Help with mathematics and calculations.
15. Translate Bengali and English.
16. Correct and rewrite text.
17. Help with programming and technology.
18. Explain programming errors.
19. Generate HTML, CSS, JavaScript, Python, Node.js and other code.
20. Give useful ideas and suggestions.

Language behavior:

- If the user writes Bengali, normally answer in Bengali.
- If the user writes English, normally answer in English.
- If the user asks for another language, use that language.
- Keep answers natural and easy to understand.
- Do not unnecessarily mention that you are an AI.
- Do not use overly complicated language unless requested.
- If the user asks for a post, give a ready-to-copy post.
- If the user asks for a story, make it engaging.
- If the user asks for a poem, make it original.
- If the user asks for a song, create original lyrics rather than reproducing copyrighted lyrics.
- For coding requests, provide clean and usable code.
- Be respectful and friendly.

You are running inside WhatsApp.
Keep normal answers reasonably concise unless the user asks for details.
`;

/* =========================================================
   AI FUNCTION
========================================================= */

async function askAI(prompt) {
  try {
    const result =
      await geminiAI.models.generateContent({
        model: AI_MODEL,
        contents: String(prompt),
        config: {
          systemInstruction:
            SYSTEM_INSTRUCTION,

          temperature: 0.7,

          maxOutputTokens: 1200
        }
      });

    let text = "";

    if (result?.text) {
      text = result.text;
    }

    if (!text && result?.candidates?.length) {
      const parts =
        result.candidates[0]?.content?.parts || [];

      text = parts
        .map(part => part?.text || "")
        .join("");
    }

    if (!text.trim()) {
      return "দুঃখিত আব্বু, এই প্রশ্নের জন্য এখন কোনো উত্তর তৈরি করতে পারলাম না।";
    }

    return text.trim();

  } catch (error) {
    console.error(
      "Gemini Error:",
      error?.message || error
    );

    return "দুঃখিত আব্বু, AI-এর সাথে যোগাযোগ করতে সমস্যা হচ্ছে। কিছুক্ষণ পর আবার চেষ্টা করো।";
  }
}

/* =========================================================
   HTTP SERVER
========================================================= */

const server = http.createServer(
  (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8"
    });

    res.end(
      `${BOT_NAME} is running successfully.`
    );
  }
);

server.listen(PORT, () => {
  console.log(
    `HTTP server running on port ${PORT}`
  );
});

/* =========================================================
   LOGGER
========================================================= */

const logger = P({
  level: "silent"
});

/* =========================================================
   WHATSAPP CONNECTION
========================================================= */

let reconnecting = false;

async function startBot() {
  try {
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, {
        recursive: true
      });
    }

    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(
      AUTH_DIR
    );

    const sock = makeWASocket({
      auth: state,

      logger,

      browser: Browsers.ubuntu(
        "Chrome"
      ),

      printQRInTerminal: false,

      markOnlineOnConnect: false,

      syncFullHistory: false
    });

    /* =====================================================
       SAVE AUTHENTICATION
    ===================================================== */

    sock.ev.on(
      "creds.update",
      saveCreds
    );

    /* =====================================================
       CONNECTION UPDATE
    ===================================================== */

    sock.ev.on(
      "connection.update",
      async update => {

        const {
          connection,
          lastDisconnect
        } = update;

        if (connection === "open") {

          reconnecting = false;

          console.log(
            `\n${BOT_NAME} connected successfully.`
          );

          console.log(
            `AI Model: ${AI_MODEL}`
          );

        }

        if (connection === "close") {

          const statusCode =
            lastDisconnect?.error
              ? new Boom(
                  lastDisconnect.error
                ).output?.statusCode
              : null;

          const shouldReconnect =
            statusCode !==
            DisconnectReason.loggedOut;

          console.log(
            "\nWhatsApp connection closed."
          );

          console.log(
            "Reconnect:",
            shouldReconnect
          );

          if (
            shouldReconnect &&
            !reconnecting
          ) {

            reconnecting = true;

            console.log(
              "Reconnecting in 5 seconds..."
            );

            setTimeout(
              () => {
                startBot();
              },
              5000
            );
          }

          if (
            statusCode ===
            DisconnectReason.loggedOut
          ) {

            console.log(
              "WhatsApp session logged out."
            );

            console.log(
              "Delete auth_info and pair again."
            );
          }
        }
      }
    );

    /* =====================================================
       PAIRING CODE
    ===================================================== */

    if (
      !state.creds.registered
    ) {

      console.log(
        "\nWhatsApp is not connected yet."
      );

      console.log(
        "Generating pairing code..."
      );

      try {

        const pairingCode =
          await sock.requestPairingCode(
            PHONE_NUMBER
          );

        console.log(
          "\n================================"
        );

        console.log(
          "WHATSAPP PAIRING CODE"
        );

        console.log(
          "================================"
        );

        console.log(
          pairingCode
        );

        console.log(
          "================================"
        );

        console.log(
          "WhatsApp > Linked Devices > Link a device > Link with phone number"
        );

        console.log(
          "Enter the code shown above."
        );

        console.log(
          "================================\n"
        );

      } catch (error) {

        console.error(
          "Pairing code error:",
          error?.message || error
        );
      }
    }

    /* =====================================================
       MESSAGE HANDLER
    ===================================================== */

    sock.ev.on(
      "messages.upsert",
      async ({ messages }) => {

        for (const msg of messages) {

          try {

            if (!msg?.message) {
              continue;
            }

            /*
             * Ignore messages sent by the bot itself
             */

            if (
              msg.key?.fromMe
            ) {
              continue;
            }

            const remoteJid =
              msg.key?.remoteJid;

            if (!remoteJid) {
              continue;
            }

            /*
             * Ignore status messages
             */

            if (
              remoteJid ===
              "status@broadcast"
            ) {
              continue;
            }

            /* =============================================
               GET MESSAGE TEXT
            ============================================= */

            const message =
              msg.message;

            let text = "";

            if (
              message.conversation
            ) {

              text =
                message.conversation;

            } else if (
              message.extendedTextMessage
                ?.text
            ) {

              text =
                message
                  .extendedTextMessage
                  .text;

            } else if (
              message.imageMessage
                ?.caption
            ) {

              text =
                message
                  .imageMessage
                  .caption;

            } else if (
              message.videoMessage
                ?.caption
            ) {

              text =
                message
                  .videoMessage
                  .caption;

            } else {

              continue;
            }

            text =
              String(text).trim();

            if (!text) {
              continue;
            }

            console.log(
              `Message from ${remoteJid}: ${text}`
            );

            /* =============================================
               COMMAND /AI
            ============================================= */

            const lowerText =
              text.toLowerCase();

            const aiCommand =
              `${PREFIX}ai`;

            const askCommand =
              `${PREFIX}ask`;

            let aiPrompt = "";

            if (
              lowerText ===
              aiCommand
            ) {

              aiPrompt =
                "Hello! Start a friendly conversation with me.";

            } else if (
              lowerText.startsWith(
                aiCommand + " "
              )
            ) {

              aiPrompt =
                text.slice(
                  aiCommand.length
                ).trim();

            } else if (
              lowerText ===
              askCommand
            ) {

              aiPrompt =
                "Hello! Start a friendly conversation with me.";

            } else if (
              lowerText.startsWith(
                askCommand + " "
              )
            ) {

              aiPrompt =
                text.slice(
                  askCommand.length
                ).trim();
            }

            /* =============================================
               DIRECT AI CHAT
            ============================================= */

            /*
             * If message starts with /ai or /ask,
             * always process it.
             */

            if (aiPrompt) {

              await sock.sendPresenceUpdate(
                "composing",
                remoteJid
              );

              const answer =
                await askAI(aiPrompt);

              await sock.sendMessage(
                remoteJid,
                {
                  text: answer
                },
                {
                  quoted: msg
                }
              );

              await sock.sendPresenceUpdate(
                "paused",
                remoteJid
              );

              continue;
            }

            /* =============================================
               DIRECT CHAT MODE
            ============================================= */

            /*
             * In this mode, normal messages also go
             * to Gemini.
             *
             * Example:
             *
             * "একটা সুন্দর প্রেমের গল্প বলো"
             *
             * The bot will answer directly.
             */

            await sock.sendPresenceUpdate(
              "composing",
              remoteJid
            );

            const answer =
              await askAI(text);

            await sock.sendMessage(
              remoteJid,
              {
                text: answer
              },
              {
                quoted: msg
              }
            );

            await sock.sendPresenceUpdate(
              "paused",
              remoteJid
            );

          } catch (error) {

            console.error(
              "Message handling error:",
              error?.message || error
            );
          }
        }
      }
    );

  } catch (error) {

    console.error(
      "Bot startup error:",
      error?.message || error
    );

    if (!reconnecting) {

      reconnecting = true;

      setTimeout(
        () => {
          startBot();
        },
        5000
      );
    }
  }
}

/* =========================================================
   START BOT
========================================================= */

console.log(
  `Starting ${BOT_NAME}...`
);

console.log(
  `AI Model: ${AI_MODEL}`
);

startBot();

/* =========================================================
   PROCESS ERROR HANDLING
========================================================= */

process.on(
  "uncaughtException",
  error => {

    console.error(
      "Uncaught Exception:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {

    console.error(
      "Unhandled Rejection:",
      error
    );
  }
);