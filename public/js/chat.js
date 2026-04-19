/**
 * EnverBot UI: chat with /chat API, welcome panel, sidebar, typing, scroll.
 * Server-side conversation memory is unchanged; "New Chat" only clears this page.
 */

(function () {
  const form = document.getElementById("chat-form");
  const input = document.getElementById("user-input");
  const sendBtn = document.getElementById("send-btn");
  const messagesEl = document.getElementById("messages");
  const messagesScroll = document.getElementById("messages-scroll");
  const typingEl = document.getElementById("typing-indicator");
  const welcomePanel = document.getElementById("welcome-panel");
  const suggestedPrompts = document.getElementById("suggested-prompts");
  const btnNewChat = document.getElementById("btn-new-chat");
  const chatSearch = document.getElementById("chat-search");
  const recentList = document.getElementById("recent-list");
  const btnSettings = document.getElementById("btn-settings");
  const settingsDialog = document.getElementById("settings-dialog");
  const settingsBackdrop = document.getElementById("settings-dialog-backdrop");
  const btnCloseSettings = document.getElementById("btn-close-settings");
  const sidebar = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const sidebarBackdrop = document.getElementById("sidebar-backdrop");

  const MAX_LENGTH = 2000;

  let waiting = false;
  /** After the user sends once, we hide the large welcome panel */
  let startedChat = false;

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

  function setWaiting(isWaiting) {
    waiting = isWaiting;
    sendBtn.disabled = isWaiting;
    input.disabled = isWaiting;
    form.setAttribute("aria-busy", isWaiting ? "true" : "false");
  }

  function collapseWelcome() {
    if (!startedChat && welcomePanel) {
      startedChat = true;
      welcomePanel.classList.add("is-collapsed");
    }
  }

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

  /** Clears on-screen messages and shows the welcome panel again (UI only). */
  function newChat() {
    messagesEl.innerHTML = "";
    startedChat = false;
    if (welcomePanel) {
      welcomePanel.classList.remove("is-collapsed");
    }
    closeSidebarMobile();
    input.focus();
    scrollToBottom();
  }

  function openSettings() {
    settingsDialog.hidden = false;
    settingsBackdrop.hidden = false;
    btnCloseSettings.focus();
  }

  function closeSettings() {
    settingsDialog.hidden = true;
    settingsBackdrop.hidden = true;
    btnSettings.focus();
  }

  function openSidebarMobile() {
    sidebar.classList.add("is-open");
    sidebarBackdrop.hidden = false;
    sidebarToggle.setAttribute("aria-expanded", "true");
  }

  function closeSidebarMobile() {
    sidebar.classList.remove("is-open");
    sidebarBackdrop.hidden = true;
    sidebarToggle.setAttribute("aria-expanded", "false");
  }

  function toggleSidebarMobile() {
    if (sidebar.classList.contains("is-open")) {
      closeSidebarMobile();
    } else {
      openSidebarMobile();
    }
  }

  /* ----- Suggested prompts: fill + send ----- */
  if (suggestedPrompts) {
    suggestedPrompts.addEventListener("click", function (e) {
      const btn = e.target.closest(".suggest-chip");
      if (!btn || waiting) return;
      const prompt = btn.getAttribute("data-prompt");
      if (!prompt) return;
      input.value = prompt;
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    });
  }

  btnNewChat.addEventListener("click", function () {
    if (waiting) return;
    newChat();
  });

  /* ----- Search: filter sample recent chats ----- */
  chatSearch.addEventListener("input", function () {
    const q = chatSearch.value.trim().toLowerCase();
    const items = recentList.querySelectorAll(".recent-item");
    items.forEach(function (el) {
      const title = (el.getAttribute("data-title") || el.textContent || "").toLowerCase();
      el.hidden = q.length > 0 && !title.includes(q);
    });
  });

  btnSettings.addEventListener("click", openSettings);
  btnCloseSettings.addEventListener("click", closeSettings);
  settingsBackdrop.addEventListener("click", closeSettings);

  sidebarToggle.addEventListener("click", toggleSidebarMobile);
  sidebarBackdrop.addEventListener("click", closeSidebarMobile);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !settingsDialog.hidden) {
      closeSettings();
    }
    if (e.key === "Escape" && sidebar.classList.contains("is-open")) {
      closeSidebarMobile();
    }
  });

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

    collapseWelcome();
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

  input.focus();
})();
