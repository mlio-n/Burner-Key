/**
 * 3rd-Party BYOK App Simulator + Header View Switcher.
 * Owner: Utku
 */

import { API_BASE, fetchModels, sendMessage } from "./api.js";

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setupViewToggle() {
  const buttons = document.querySelectorAll("button[data-view-mode]");
  const dashCol = document.getElementById("dashboard-col");
  const simCol = document.getElementById("simulator-col");
  const mainGrid = document.getElementById("main-grid");

  function applyMode(mode) {
    buttons.forEach((btn) => {
      const active = btn.dataset.viewMode === mode;
      btn.className = active
        ? "rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition"
        : "rounded-lg px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 transition";
    });

    if (mode === "split") {
      mainGrid.className = "grid grid-cols-1 xl:grid-cols-12 gap-5 items-start";
      dashCol.className = "xl:col-span-7";
      simCol.className = "xl:col-span-5 xl:sticky xl:top-20";
      dashCol.classList.remove("hidden");
      simCol.classList.remove("hidden");
    } else if (mode === "dashboard") {
      mainGrid.className = "grid grid-cols-1 gap-5";
      dashCol.className = "";
      dashCol.classList.remove("hidden");
      simCol.classList.add("hidden");
    } else {
      mainGrid.className = "grid grid-cols-1 gap-5";
      simCol.className = "";
      dashCol.classList.add("hidden");
      simCol.classList.remove("hidden");
    }
  }

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => applyMode(btn.dataset.viewMode));
  });
}

// "claude-3-5-haiku-20241022" -> "claude-3-5-haiku" (only for display; the API still needs the full id)
function modelLabel(model) {
  return String(model).replace(/-\d{8}$/, "");
}

export async function initSimulator() {
  setupViewToggle();

  const root = document.getElementById("simulator-root");
  if (!root) return;

  const displayBase = API_BASE || window.location.origin;

  root.innerHTML = `
    <div class="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-4">
      <!-- Header -->
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
        <div>
          <h2 class="text-sm font-semibold text-white">
            3. Parti BYOK AI Uygulaması (Simülatör)
          </h2>
          <p class="font-mono text-[11px] text-slate-400">
            POST ${escapeHtml(displayBase)}/v1/messages
          </p>
        </div>
        <span class="rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-medium text-sky-300">
          Anthropic Uyumlu
        </span>
      </div>

      <!-- Key + Model -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
        <div class="sm:col-span-2">
          <label class="block text-slate-400 mb-1">Burner Key (x-api-key)</label>
          <input
            id="simApiKey"
            type="text"
            placeholder="brk_live_... yapıştırın veya panelden üretin"
            class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-emerald-300 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
          />
        </div>
        <div>
          <label class="block text-slate-400 mb-1">Model</label>
          <select
            id="simModel"
            class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-slate-100 focus:border-sky-500 focus:outline-none"
          >
            <option value="claude-3-5-haiku-20241022">claude-3-5-haiku</option>
          </select>
        </div>
      </div>

      <!-- Prompt Form -->
      <form id="simPromptForm" class="flex gap-2">
        <input
          id="simPromptInput"
          type="text"
          value="Merhaba Claude, kodumu özetler misin?"
          placeholder="3. parti uygulamadan mesaj gönder..."
          class="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
        />
        <button
          id="simSendBtn"
          type="submit"
          class="rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50 transition"
        >
          Gönder
        </button>
      </form>

      <!-- Demo Attack / Guardrail Buttons -->
      <div class="rounded-lg border border-slate-800 bg-slate-950/70 p-3 space-y-2">
        <p class="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Demo İhlal Senaryoları
        </p>
        <div class="flex flex-wrap gap-2">
          <button
            id="forbiddenModelBtn"
            type="button"
            class="rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-xs font-semibold text-amber-300 hover:bg-amber-500/25 transition"
          >
            Yasaklı Model Dene (Opus • 403)
          </button>
          <button
            id="loopBugBtn"
            type="button"
            class="rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/25 transition"
          >
            Sonsuz Döngü Bug'ı Tetikle (429)
          </button>
        </div>
      </div>

      <!-- Console -->
      <div class="rounded-lg border border-slate-800 bg-slate-950 p-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Uygulama Yanıt Konsolu
          </span>
          <button id="clearConsoleBtn" type="button" class="text-[11px] text-slate-500 hover:text-slate-300">
            Temizle
          </button>
        </div>
        <div id="simConsole" class="space-y-2 max-h-96 overflow-y-auto custom-scroll pr-1">
          <p class="py-10 text-center text-xs text-slate-500">
            Simülatör hazır. Normal mesaj atın veya ihlal senaryolarını tetikleyin.
          </p>
        </div>
      </div>
    </div>
  `;

  try {
    const models = await fetchModels();
    const select = document.getElementById("simModel");
    select.innerHTML = models
      .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(modelLabel(m))}</option>`)
      .join("");
  } catch {
    // Keep fallback option
  }

  const keyInput = document.getElementById("simApiKey");
  const modelSelect = document.getElementById("simModel");
  const promptInput = document.getElementById("simPromptInput");
  const consoleEl = document.getElementById("simConsole");
  const loopBtn = document.getElementById("loopBugBtn");

  let events = [];
  let loopTimer = null;
  let loopCount = 0;

  window.addEventListener("burner:select-key", (e) => {
    if (e.detail?.apiKey) {
      keyInput.value = e.detail.apiKey;
    }
  });

  function renderConsole() {
    if (!events.length) {
      consoleEl.innerHTML = `
        <p class="py-10 text-center text-xs text-slate-500">
          Simülatör hazır. Normal mesaj atın veya ihlal senaryolarını tetikleyin.
        </p>
      `;
      return;
    }

    consoleEl.innerHTML = events
      .map(
        (ev) => `
        <div class="rounded-lg border p-3 text-xs ${
          ev.ok ? "border-emerald-500/30 bg-emerald-950/20" : "border-rose-500/40 bg-rose-950/30"
        }">
          <div class="flex flex-wrap items-center justify-between gap-2 mb-1">
            <div class="flex items-center gap-2">
              <span class="rounded px-1.5 py-0.5 font-mono text-[11px] font-bold ${
                ev.ok ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"
              }">
                ${ev.status || "ERR"} ${ev.ok ? "OK" : escapeHtml(ev.errType)}
              </span>
              <span class="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">
                ${escapeHtml(ev.tag)}
              </span>
              <span class="font-mono text-[11px] text-slate-400">${escapeHtml(modelLabel(ev.model))}</span>
            </div>
            <span class="font-mono text-[11px] text-slate-500">
              ${ev.tokens ? `${ev.tokens} tok • ` : ""}${ev.time}
            </span>
          </div>
          <p class="${ev.ok ? "text-slate-200" : "text-rose-200"}">${escapeHtml(ev.text)}</p>
        </div>
      `
      )
      .join("");
  }

  function pushEvent(entry) {
    events = [
      {
        time: new Date().toLocaleTimeString("tr-TR"),
        ...entry,
      },
      ...events.slice(0, 29),
    ];
    renderConsole();
  }

  async function runProxyCall(targetModel, targetPrompt, tag) {
    const key = keyInput.value.trim();
    if (!key) {
      pushEvent({
        ok: false,
        status: 0,
        errType: "NO_KEY",
        tag,
        model: targetModel,
        text: "Önce soldaki panelden bir Burner Key üretin veya buraya yapıştırın.",
      });
      return { ok: false, status: 0 };
    }

    try {
      const res = await sendMessage(key, targetModel, targetPrompt);
      if (res.ok) {
        const text = res.data?.content?.[0]?.text || "Yanıt alındı.";
        const usage = res.data?.usage || {};
        pushEvent({
          ok: true,
          status: res.status,
          tag,
          model: targetModel,
          tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
          text,
        });
      } else {
        const err = res.data?.error || {};
        pushEvent({
          ok: false,
          status: res.status,
          errType: err.type || "error",
          tag,
          model: targetModel,
          text: err.message || "İstek engellendi.",
        });
      }
      window.dispatchEvent(new CustomEvent("burner:activity"));
      return res;
    } catch (err) {
      pushEvent({
        ok: false,
        status: 0,
        errType: "NETWORK",
        tag,
        model: targetModel,
        text: err.message || "Proxy sunucusuna ulaşılamadı.",
      });
      return { ok: false, status: 0 };
    }
  }

  function stopLoop() {
    if (loopTimer) {
      clearInterval(loopTimer);
      loopTimer = null;
    }
    loopBtn.textContent = "Sonsuz Döngü Bug'ı Tetikle (429)";
    loopBtn.className =
      "rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/25 transition";
  }

  document.getElementById("simPromptForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const prompt = promptInput.value.trim();
    if (!prompt || loopTimer) return;
    await runProxyCall(modelSelect.value, prompt, "SOHBET");
  });

  document.getElementById("forbiddenModelBtn").addEventListener("click", async () => {
    if (loopTimer) return;
    await runProxyCall(
      "claude-3-opus-20240229",
      "İzinsiz pahalı model isteği gönderiliyor.",
      "YASAKLI MODEL"
    );
  });

  loopBtn.addEventListener("click", () => {
    if (loopTimer) {
      stopLoop();
      return;
    }

    loopCount = 0;
    let inFlight = false;
    loopBtn.className =
      "rounded-lg border border-rose-500 bg-rose-600 px-3 py-2 text-xs font-semibold text-white loop-active-ring transition";

    loopTimer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      loopCount += 1;
      loopBtn.textContent = `Döngüyü Durdur (${loopCount} istek)`;
      const res = await runProxyCall(
        modelSelect.value,
        `Agent loop retry #${loopCount}`,
        "SONSUZ DÖNGÜ"
      );
      inFlight = false;
      if (!res.ok) {
        stopLoop();
      }
    }, 350);
  });

  document.getElementById("clearConsoleBtn").addEventListener("click", () => {
    events = [];
    renderConsole();
  });
}
