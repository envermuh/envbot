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
const { createClient } = require("@supabase/supabase-js");

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

/**
 * Supabase client (for persistent memory)
 * Reads these from .env:
 * - SUPABASE_URL
 * - SUPABASE_SECRET_KEY  (service role key; keep it server-side only)
 */
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const supabase =
  supabaseUrl && supabaseSecretKey
    ? createClient(supabaseUrl, supabaseSecretKey)
    : null;

// Default model: cheap and capable; override with OPENAI_MODEL in .env
const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

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
 * In-memory conversation history (per session_id).
 * Note: this is NOT persistent; it resets when the server restarts.
 * Supabase is used below for persistent profile memory (name, etc.).
 */
const conversationBySession = new Map();

function getConversation(sessionId) {
  if (!conversationBySession.has(sessionId)) {
    conversationBySession.set(sessionId, []);
  }
  return conversationBySession.get(sessionId);
}

/** Keep only the newest turns so the array never grows beyond MAX_MESSAGES. */
function trimHistory(conversation) {
  return conversation.slice(-MAX_MESSAGES);
}

/** Extract a name from messages like: "my name is X" */
function extractNameFromMessage(text) {
  const m = text.match(/\bmy\s+name\s+is\s+(.+?)\s*$/i);
  if (!m) return null;
  const name = m[1].trim();
  if (!name) return null;
  // Keep names small and safe (basic beginner-friendly constraint)
  if (name.length > 60) return null;
  return name;
}

/**
 * Tavily web search (grounding).
 * We keep it small + simple: top 3–5 results with title + url + snippet.
 */
async function tavilySearch(query) {
  if (!TAVILY_API_KEY) {
    return { results: [], weak: true, error: "missing_key" };
  }

  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: "basic",
      max_results: 5,
      include_answer: false,
      include_images: false,
      include_raw_content: false,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error("Tavily error:", data?.message || `HTTP ${resp.status}`);
    return { results: [], weak: true, error: "tavily_failed" };
  }

  const raw = Array.isArray(data?.results) ? data.results : [];
  const results = raw
    .filter((r) => r && r.url && r.title)
    .slice(0, 5)
    .map((r, idx) => ({
      idx: idx + 1,
      title: String(r.title).trim(),
      url: String(r.url).trim(),
      snippet: String(r.content || r.snippet || "").trim(),
      score: typeof r.score === "number" ? r.score : null,
    }))
    .filter((r) => r.title && r.url);

  const weak = results.length < 3;
  return { results, weak, error: null };
}

function formatSearchContext(results) {
  return results
    .map((r) => {
      const snippet = r.snippet ? `Snippet: ${r.snippet}` : "Snippet: (none)";
      return `[${r.idx}] ${r.title}\nURL: ${r.url}\n${snippet}`;
    })
    .join("\n\n");
}

async function readUserProfile(sessionId) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("user_profiles")
    .select("session_id,name,updated_at")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error) {
    // Don't fail the whole chat if Supabase is down; just log and continue.
    console.error("Supabase readUserProfile error:", error.message || error);
    return null;
  }
  return data || null;
}

async function upsertUserName(sessionId, name) {
  if (!supabase) return;
  const payload = {
    session_id: sessionId,
    name,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("user_profiles").upsert(payload, {
    onConflict: "session_id",
  });
  if (error) {
    console.error("Supabase upsertUserName error:", error.message || error);
  }
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
  const sessionIdRaw = req.body?.session_id;
  const sessionId =
    typeof sessionIdRaw === "string" && sessionIdRaw.trim()
      ? sessionIdRaw.trim().slice(0, 100)
      : "anonymous";

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

  const conversationHistory = getConversation(sessionId);
  // Snapshot so we can undo the user turn if the API call fails
  const historySnapshot = conversationHistory.slice();

  try {
    // Web grounding: search before answering (Tavily)
    const search = await tavilySearch(trimmed);
    if (search.error === "missing_key") {
      return res.status(503).json({
        error:
          "Tavily web search is not configured. Add TAVILY_API_KEY to your .env file and restart the server.",
      });
    }

    // Persistent profile memory: if user says "my name is X", store it by session_id
    const extractedName = extractNameFromMessage(trimmed);
    if (extractedName) {
      await upsertUserName(sessionId, extractedName);
    }

    // Load profile before responding (persistent memory)
    const profile = await readUserProfile(sessionId);

    conversationHistory.push({ role: "user", content: trimmed });
    const trimmedHistory = trimHistory(conversationHistory);
    conversationBySession.set(sessionId, trimmedHistory);

    // System message is always first and is not part of history (so it is never trimmed away)
    const messagesForModel = [{ role: "system", content: SYSTEM_PROMPT }];

    // Grounding rules: answer ONLY from search results, otherwise say you're not sure.
    const groundingRules = [
      "You must answer using ONLY the information in the provided web search results.",
      "Do NOT use prior knowledge. If the sources are weak/unclear or don't answer the question, say you are not sure.",
      "Be clear and medium-length. If you make a claim, support it with a source.",
      "When possible, include a short 'Sources' section listing the URLs you used.",
      "If sources disagree, mention the uncertainty briefly.",
    ].join(" ");

    messagesForModel.push({ role: "system", content: groundingRules });

    // Add persistent profile memory as an extra system hint (simple + safe)
    if (profile?.name) {
      messagesForModel.push({
        role: "system",
        content:
          `User profile: the user's name is ${profile.name}. ` +
          "Use it naturally sometimes, but don't overdo it.",
      });
    }

    // Add the search results as context for the model
    const searchContext = formatSearchContext(search.results);
    messagesForModel.push({
      role: "system",
      content:
        "Web search results (use these as your only source of factual information):\n\n" +
        (searchContext || "(no results)"),
    });

    // Conversation history helps with continuity, but grounding rules still apply.
    messagesForModel.push(...trimmedHistory);

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: messagesForModel,
      max_tokens: 550,
    });

    const reply =
      completion.choices[0]?.message?.content?.trim() ||
      "The model returned an empty reply.";

    const afterAssistant = trimmedHistory.concat([
      { role: "assistant", content: reply },
    ]);
    conversationBySession.set(sessionId, trimHistory(afterAssistant));

    return res.json({ reply });
  } catch (err) {
    conversationBySession.set(sessionId, historySnapshot);
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
  if (!supabase) {
    console.warn(
      "[Warning] Supabase is not configured. Add SUPABASE_URL and SUPABASE_SECRET_KEY to enable persistent profile memory.\n"
    );
  }
});
