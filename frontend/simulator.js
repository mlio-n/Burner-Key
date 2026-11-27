/**
 * 3rd-Party BYOK App Simulator + top bar (view switcher, clock).
 * Owner: Utku
 */

import { createKey, fetchModels, revokeKey, sendMessage } from "./api.js";

const VIEW_STORAGE_KEY = "burner:view";
const LOOP_LABEL = "Sonsuz döngü";

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// "claude-3-5-haiku-20241022" -> "claude-3-5-haiku", "llama-3.3-70b-versatile" -> "llama-3.3-70b"
// (only for display; the API still needs the full id)
function modelLabel(model) {
  return String(model)
    .replace(/-\d{8}$/, "")
    .replace(/-(versatile|latest|instruct|preview)$/, "");
}

function setupViewToggle() {
  const buttons = document.querySelectorAll("button[data-view-mode]");

  function applyMode(mode) {
    document.body.dataset.view = mode;
    buttons.forEach((btn) => btn.setAttribute("aria-pressed", String(btn.dataset.viewMode === mode)));
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, mode);
    } catch {
      // storage unavailable: view just isn't remembered
    }
  }

  buttons.forEach((btn) => btn.addEventListener("click", () => applyMode(btn.dataset.viewMode)));

  let saved = null;
  try {
    saved = localStorage.getItem(VIEW_STORAGE_KEY);
  } catch {
    saved = null;
  }
  if (["split", "dashboard", "simulator"].includes(saved)) applyMode(saved);
}

function setupClock() {
  const el = document.getElementById("clock");
  if (!el) return;
  const tick = () => {
    el.textContent = new Date().toLocaleTimeString("tr-TR", { hour12: false });
  };
  tick();
  setInterval(tick, 1000);
}

export async function initSimulator() {
  setupViewToggle();
  setupClock();

  const root = document.getElementById("simulator-root");
  if (!root) return;

  root.innerHTML = `
    <section class="panel sim">
      <header class="panel-head sim-head">
        <span><span class="idx">04</span>Simülatör · 3. Parti App</span>
        <span class="muted">POST /v1/messages</span>
      </header>

      <div class="sim-body">
      <div class="sim-controls">
      <div class="sim-grid">
        <div class="field">
          <label class="label" for="simApiKey">x-api-key</label>
          <input id="simApiKey" class="input mono" type="text" spellcheck="false" placeholder="brk_live_…" />
        </div>
        <div class="field">
          <label class="label" for="simModel">Model</label>
          <select id="simModel" class="select">
            <option value="claude-3-5-haiku-20241022">claude-3-5-haiku</option>
          </select>
        </div>
      </div>

      <form id="simPromptForm" class="sim-prompt">
        <input
          id="simPromptInput"
          class="input"
          type="text"
          aria-label="Mesaj"
          value="Merhaba Claude, kodumu özetler misin?"
          placeholder="Mesaj gönder…"
        />
        <button id="simSendBtn" type="submit" class="btn-primary"><span>GÖNDER</span><span aria-hidden="true">↵</span></button>
      </form>

      <div class="scen">
        <button id="burnedKeyBtn" type="button" title="Geçici bir anahtar üretir, yakar ve onunla istek atar. Mevcut anahtarınız etkilenmez."><i aria-hidden="true">▶</i><b>401</b><span id="burnedKeyLabel">Yanmış anahtar</span></button>
        <button id="loopBugBtn" type="button"><i aria-hidden="true">▶</i><b>429</b><span id="loopBtnLabel">${LOOP_LABEL}</span></button>
      </div>
      </div>

      <div class="term">
        <header class="term-head">
          <span>Konsol <span class="term-sub">· uygulama çıktısı</span></span>
          <button id="clearConsoleBtn" type="button" class="btn-text">Temizle</button>
        </header>
        <div id="simConsole" class="console" aria-live="polite"></div>
      </div>
      </div>
    </section>
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
  const loopLabel = document.getElementById("loopBtnLabel");

  let events = [];
  let loopTimer = null;
  let loopCount = 0;

  window.addEventListener("burner:select-key", (e) => {
    if (e.detail?.apiKey) {
      keyInput.value = e.detail.apiKey;
      // Restart the flash so repeated TEST → clicks are visible too.
      keyInput.classList.remove("flash");
      void keyInput.offsetWidth;
      keyInput.classList.add("flash");
    }
  });

  function renderConsole() {
    if (!events.length) {
      consoleEl.innerHTML = `<div class="console-empty">HAZIR · MESAJ GÖNDERİN VEYA BİR İHLAL SENARYOSU TETİKLEYİN</div>`;
      return;
    }

    consoleEl.innerHTML = events
      .map((ev) => {
        // info rows are neutral system notes (e.g. the 401 demo burning its key), not responses
        const cls = ev.info ? "info" : ev.ok ? "" : "err";
        const code = ev.info ? "SYS" : ev.status || "ERR";
        const tag = ev.info || ev.ok ? ev.tag : `${ev.tag} · ${ev.errType}`;
        return `
        <div class="ev ${cls}">
          <div class="ev-meta">
            <span class="code ${cls}">${code}</span>
            <span class="tag">${escapeHtml(tag)}</span>
            <span class="muted">${escapeHtml(modelLabel(ev.model))}</span>
            <span class="end">${ev.tokens ? `${ev.tokens} TOK · ` : ""}${ev.time}</span>
          </div>
          <p>${escapeHtml(ev.text)}</p>
        </div>
      `;
      })
      .join("");
  }

  function pushEvent(entry) {
    events = [
      {
        time: new Date().toLocaleTimeString("tr-TR", { hour12: false }),
        ...entry,
      },
      ...events.slice(0, 29),
    ];
    renderConsole();
  }

  async function runProxyCall(targetModel, targetPrompt, tag, overrideKey = null) {
    const key = (overrideKey ?? keyInput.value).trim();
    if (!key) {
      pushEvent({
        ok: false,
        status: 0,
        errType: "NO_KEY",
        tag,
        model: targetModel,
        text: "Önce panelden bir Burner Key üretin veya buraya yapıştırın.",
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
    loopLabel.textContent = LOOP_LABEL;
    loopBtn.classList.remove("is-running");
    loopBtn.querySelector("i").textContent = "▶";
  }

  renderConsole();

  document.getElementById("simPromptForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const prompt = promptInput.value.trim();
    if (!prompt || loopTimer) return;
    await runProxyCall(modelSelect.value, prompt, "SOHBET");
  });

  // 401 demo: mint a throwaway key, burn it (kill switch), then call the proxy with it.
  // Uses its own key so the one in the x-api-key field keeps working.
  const burnedBtn = document.getElementById("burnedKeyBtn");
  const burnedLabel = document.getElementById("burnedKeyLabel");
  burnedBtn.addEventListener("click", async () => {
    if (loopTimer || burnedBtn.disabled) return;
    burnedBtn.disabled = true;
    burnedLabel.textContent = "Yakılıyor…";
    try {
      const demo = await createKey({
        name: "401 Demo · yanmış anahtar",
        budget_limit_usd: 0.005,
        ttl_minutes: 15,
        allowed_models: ["*"],
        master_key_id: null,
      });
      await revokeKey(demo.id);
      pushEvent({
        info: true,
        tag: "KILL SWITCH",
        model: modelSelect.value,
        text: `Geçici anahtar #${String(demo.id).padStart(3, "0")} (${demo.key_preview}) üretildi ve yakıldı. Şimdi bu anahtarla istek atılıyor…`,
      });
      window.dispatchEvent(new CustomEvent("burner:activity"));
      await runProxyCall(modelSelect.value, "Yakılmış anahtarla istek deneniyor.", "YANMIŞ ANAHTAR", demo.api_key);
    } catch (err) {
      pushEvent({
        ok: false,
        status: 0,
        errType: "DEMO",
        tag: "YANMIŞ ANAHTAR",
        model: modelSelect.value,
        text: err.message || "Demo anahtar hazırlanamadı.",
      });
    } finally {
      burnedBtn.disabled = false;
      burnedLabel.textContent = "Yanmış anahtar";
    }
  });

  loopBtn.addEventListener("click", () => {
    if (loopTimer) {
      stopLoop();
      return;
    }

    loopCount = 0;
    let inFlight = false;
    loopBtn.classList.add("is-running");
    loopBtn.querySelector("i").textContent = "■";

    loopTimer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      loopCount += 1;
      loopLabel.textContent = `Durdur · ${String(loopCount).padStart(3, "0")} REQ`;
      const res = await runProxyCall(modelSelect.value, `Agent loop retry #${loopCount}`, "SONSUZ DÖNGÜ");
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
