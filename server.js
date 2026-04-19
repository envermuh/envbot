/**
 * Simple Express server for the AI chat demo.
 * Serves the static frontend from /public and exposes POST /chat.
 * Uses the OpenAI API for real model replies (see .env).
 */

require("dotenv").config();

const express = require("express");
const path = require("path");
const rateLimit = require("express-rate-limit");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

/** Reject overly long inputs (matches frontend maxlength order-of-magnitude). */
const MAX_MESSAGE_LENGTH = 2000;

// Limit JSON body size to keep requests small and predictable
app.use(
  express.json({
    limit: "32kb",
  })
);

// Basic rate limit: per IP, only on POST /chat
const chatRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // max requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: function (req, res) {
    res.status(429).json({
      error:
        "You’re sending messages a little too fast. Please wait a moment and try again.",
    });
  },
});

// OpenAI client — reads OPENAI_API_KEY from process.env (set in .env)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Default model: cheap and capable; override with OPENAI_MODEL in .env
const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/**
 * System message: shapes tone and behavior (personality).
 * Confident, friendly, lightly witty—never rude or dismissive.
 */
const SYSTEM_PROMPT = [
  "You are a confident, warm, and approachable assistant with a light sense of humor.",
  "You may be playfully witty when it fits the moment, but stay respectful, kind, and never rude, snarky at the user's expense, or condescending.",
  "Answer helpfully and directly; jokes or quips should support clarity, not replace it.",
  "Keep answers clear and medium-length—usually a short paragraph or two, or a few bullet points when that helps, unless the user asks for more or less detail.",
].join(" ");

/** Cap for user + assistant turns (10–12 range; keeps memory bounded). */
const MAX_MESSAGES = 12;

/**
 * Only user/assistant turns live here — never the system message, so personality stays intact.
 * Trimmed after each update so this array never grows past MAX_MESSAGES.
 */
let conversationHistory = [];

/** Keep only the newest turns so the array never grows beyond MAX_MESSAGES. */
function trimHistory() {
  conversationHistory = conversationHistory.slice(-MAX_MESSAGES);
}

// Serve HTML, CSS, and JS from the public folder
app.use(express.static(path.join(__dirname, "public")));

/**
 * Map OpenAI / network failures to safe, user-facing copy (no raw stack traces).
 */
function friendlyOpenAiError(err) {
  const status = err?.status ?? err?.response?.status;
  const code = err?.code ?? err?.error?.code;

  if (status === 401 || code === "invalid_api_key") {
    return {
      http: 503,
      message:
        "The AI service rejected the API key. Check OPENAI_API_KEY in your .env file and restart the server.",
    };
  }
  if (status === 429) {
    return {
      http: 503,
      message:
        "The AI service is rate-limited right now. Please wait a short time and try again.",
    };
  }
  if (code === "insufficient_quota" || err?.type === "insufficient_quota") {
    return {
      http: 503,
      message:
        "Your OpenAI account may be out of credits or quota. Check billing on the OpenAI dashboard.",
    };
  }
  if (status === 400) {
    return {
      http: 400,
      message:
        "The AI couldn’t process that request. Try a shorter or simpler message.",
    };
  }
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || err?.cause?.code === "ETIMEDOUT") {
    return {
      http: 503,
      message:
        "The connection to the AI service timed out. Check your network and try again.",
    };
  }

  return {
    http: 502,
    message:
      "We couldn’t get a reply from the AI right now. Please try again in a moment.",
  };
}

/**
 * POST /chat
 * Body: { "message": "user text here" }
 * Response: { "reply": "..." } or { "error": "..." }
 */
app.post("/chat", chatRateLimiter, async (req, res) => {
  const message = req.body?.message;

  if (!message || typeof message !== "string") {
    return res.status(400).json({
      error:
        "That message didn’t come through correctly. Please type something and send again.",
    });
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({
      error: `Please keep messages under ${MAX_MESSAGE_LENGTH} characters.`,
    });
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return res.status(400).json({
      error: "Messages can’t be empty. Type something first.",
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error:
        "The server isn’t configured with an AI API key yet. Add OPENAI_API_KEY to your .env file and restart.",
    });
  }

  // Snapshot so we can undo the user turn if the API call fails
  const historySnapshot = conversationHistory.slice();

  try {
    conversationHistory.push({ role: "user", content: trimmed });
    trimHistory();

    // System message is always first and is not part of conversationHistory (so it is never trimmed away)
    const messagesForModel = [
      { role: "system", content: SYSTEM_PROMPT },
      ...conversationHistory,
    ];

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: messagesForModel,
      max_tokens: 550,
    });

    const reply =
      completion.choices[0]?.message?.content?.trim() ||
      "The model returned an empty reply.";

    conversationHistory.push({ role: "assistant", content: reply });
    trimHistory();

    return res.json({ reply });
  } catch (err) {
    conversationHistory = historySnapshot;
    const { http, message } = friendlyOpenAiError(err);
    console.error("Chat / OpenAI error:", err?.message || err);
    return res.status(http).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn(
      "\n[Warning] OPENAI_API_KEY is not set. Create a .env file with your key (see .env.example).\n"
    );
  } else {
    console.log(`Using OpenAI model: ${CHAT_MODEL}\n`);
  }
});
