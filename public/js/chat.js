/**
 * Frontend: chat UI, typing indicator, friendly errors, and safe input handling.
 */

(function () {
  const form = document.getElementById("chat-form");
  const input = document.getElementById("user-input");
  const sendBtn = document.getElementById("send-btn");
  const messagesEl = document.getElementById("messages");
  const messagesScroll = document.getElementById("messages-scroll");
  const typingEl = document.getElementById("typing-indicator");

  const MAX_LENGTH = 2000;

  /** True while waiting for the server / AI (blocks duplicate sends). */
  let waiting = false;

  function scrollToBottom() {
    requestAnimationFrame(function () {
      messagesScroll.scrollTop = messagesScroll.scrollHeight;
    });
  }

  function setTyping(show) {
    if (show) {
      typingEl.hidden = false;
      typingEl.setAttribute("aria-hidden", "false");
    } else {
      typingEl.hidden = true;
      typingEl.setAttribute("aria-hidden", "true");
    }
    scrollToBottom();
  }

  /** Disable send + input while a request is in flight */
  function setWaiting(isWaiting) {
    waiting = isWaiting;
    sendBtn.disabled = isWaiting;
    input.disabled = isWaiting;
    form.setAttribute("aria-busy", isWaiting ? "true" : "false");
  }

  /**
   * Prefer the server’s error string; fall back to status-based friendly text.
   */
  function friendlyErrorMessage(res, data) {
    if (data && typeof data.error === "string" && data.error.trim()) {
      return data.error.trim();
    }
    if (res.status === 429) {
      return "You’re sending messages too quickly. Give it a moment and try again.";
    }
    if (res.status === 503) {
      return "The service is temporarily unavailable. Please try again in a little bit.";
    }
    if (res.status === 502) {
      return "We couldn’t reach the AI service. Check your connection and try again.";
    }
    if (res.status === 400) {
      return "That message couldn’t be sent. Try editing it and send again.";
    }
    return "Something went wrong. Please try again.";
  }

  /**
   * Add a message bubble (user = right, assistant = left).
   * @param {"user" | "bot" | "error"} role
   * @param {string} text
   */
  function addMessage(role, text) {
    const row = document.createElement("div");
    row.className =
      "msg-row msg-row--" +
      (role === "user"
        ? "user"
        : role === "error"
          ? "error"
          : "assistant");

    const bubble = document.createElement("div");
    bubble.className =
      "msg " + (role === "error" ? "error" : role === "user" ? "user" : "bot");
    bubble.textContent = text;

    row.appendChild(bubble);
    messagesEl.appendChild(row);
    scrollToBottom();
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();

    if (waiting) return;

    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }

    if (text.length > MAX_LENGTH) {
      addMessage(
        "error",
        "That message is too long. Please shorten it to " + MAX_LENGTH + " characters or fewer."
      );
      return;
    }

    addMessage("user", text);
    input.value = "";
    setWaiting(true);
    setTyping(true);

    try {
      const res = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      let data = {};
      try {
        data = await res.json();
      } catch (_) {
        data = {};
      }

      if (!res.ok) {
        addMessage("error", friendlyErrorMessage(res, data));
        return;
      }

      if (data.reply && typeof data.reply === "string") {
        addMessage("bot", data.reply);
      } else {
        addMessage(
          "error",
          "We didn’t get a proper reply from the server. Please try again."
        );
      }
    } catch (err) {
      addMessage(
        "error",
        "Couldn’t reach the chat server. Make sure it’s running and try again."
      );
    } finally {
      setTyping(false);
      setWaiting(false);
      input.focus();
      scrollToBottom();
    }
  });

  addMessage(
    "bot",
    "Hi there — I’m here to help, with a bit of wit when it fits. Ask me anything, or just say hi."
  );
  input.focus();
})();
