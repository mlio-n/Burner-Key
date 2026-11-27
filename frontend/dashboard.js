/**
 * Admin Control Panel: quick key generator, active key list (live TTL countdown,
 * quota meter, BURN kill switch) and live proxy logs.
 * Owner: Kerim
 */

import {
  createKey,
  fetchKeys,
  fetchLogs,
  fetchMasterKeys,
  fetchModels,
  revokeKey,
} from "./api.js";

const TTL_OPTIONS = [
  ["15M", 15],
  ["1H", 60],
  ["24H", 1440],
];

const QUOTA_OPTIONS = [
  ["$0.005", 0.005],
  ["$0.05", 0.05],
  ["$0.50", 0.5],
  ["$5.00", 5],
];

const BURN_CONFIRM_MS = 3000;
const METER_CELLS = 20;

const state = {
  ttl: 60,
  budget: 0.005,
  filter: "active",
  keys: [],
  pendingBurnId: null,
  burnTimer: null,
  burningId: null,
  logsSig: "",
  // Raw keys are only returned once by POST /admin/keys, so TEST → works for keys made in this tab.
  rawKeys: new Map(),
};

const rowSigs = new Map();

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// "claude-3-5-haiku-20241022" -> "claude-3-5-haiku", "llama-3.3-70b-versatile" -> "llama-3.3-70b"
// (display only; the full id is what gets sent to the API)
function modelLabel(model) {
  return String(model)
    .replace(/-\d{8}$/, "")
    .replace(/-(versatile|latest|instruct|preview)$/, "");
}

function selectKeyInSimulator(apiKey) {
  window.dispatchEvent(new CustomEvent("burner:select-key", { detail: { apiKey } }));
}

function formatTime(iso) {
  if (!iso) return "--:--:--";
  return new Date(iso).toLocaleTimeString("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function segButtons(options, current) {
  return options
    .map(
      ([label, value]) =>
        `<button type="button" data-val="${value}" aria-pressed="${value === current}">${label}</button>`
    )
    .join("");
}

function renderShell(root) {
  root.innerHTML = `
    <div class="dash">
      <section class="panel panel-tool">
        <header class="panel-head">
          <span><span class="idx">01</span>Anahtar Üret</span>
          <span class="muted">POST /admin/keys</span>
        </header>

        <form id="createKeyForm" class="panel-body pad" autocomplete="off">
          <div class="field">
            <label class="label" for="keyName">Etiket / Uygulama</label>
            <input id="keyName" class="input" type="text" required maxlength="80" value="Cursor BYOK Demo" />
          </div>

          <div class="field">
            <div class="label"><span>Kasa (Master Key)</span></div>
            <div id="vaultList" class="opts one">
              <div class="opt"><span class="txt muted">Yükleniyor…</span></div>
            </div>
          </div>

          <div class="field">
            <div class="label"><span>Süre (TTL)</span><b id="ttlReadout"></b></div>
            <div id="ttlSeg" class="seg full" role="group" aria-label="Süre">
              ${segButtons(TTL_OPTIONS, state.ttl)}
            </div>
          </div>

          <div class="field">
            <div class="label"><span>Kota (USD)</span><b id="quotaReadout"></b></div>
            <div id="quotaSeg" class="seg full" role="group" aria-label="Kota">
              ${segButtons(QUOTA_OPTIONS, state.budget)}
            </div>
          </div>

          <div class="field">
            <div class="label"><span>İzinli Modeller</span><b id="modelCount">0 seçili</b></div>
            <div id="modelsContainer" class="opts">
              <div class="opt"><span class="txt muted">Yükleniyor…</span></div>
            </div>
          </div>

          <p id="formError" class="form-error" hidden></p>

          <button id="createKeyBtn" type="submit" class="btn-primary">
            <span>ANAHTAR ÜRET</span><span aria-hidden="true">↵</span>
          </button>

          <section id="newKeyBanner" class="reveal" hidden>
            <div class="reveal-head">
              <span>TEK SEFERLİK · ŞİMDİ KOPYALA</span>
              <button id="closeBannerBtn" type="button" aria-label="Kapat">×</button>
            </div>
            <code id="newKeyValue" class="reveal-key"></code>
            <div class="seg full">
              <button id="copyNewKeyBtn" type="button">Kopyala</button>
              <button id="sendToSimBtn" type="button">Simülatöre →</button>
            </div>
          </section>
        </form>
      </section>

      <div class="dash-right">
        <section class="panel">
          <header class="panel-head">
            <span><span class="idx">02</span>Anahtarlar</span>
            <div id="keyFilter" class="seg" role="group" aria-label="Filtre">
              <button type="button" data-val="active" aria-pressed="true">Aktif <span id="countActive">0</span></button>
              <button type="button" data-val="all" aria-pressed="false">Tümü <span id="countAll">0</span></button>
            </div>
          </header>
          <div class="panel-body">
            <table class="tbl key-tbl">
              <thead>
                <tr>
                  <th>Anahtar</th>
                  <th>Kota</th>
                  <th>Kalan</th>
                  <th class="r">Kill Switch</th>
                </tr>
              </thead>
              <tbody id="keysTableBody">
                <tr class="empty"><td colspan="4">YÜKLENİYOR…</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel panel-log">
          <header class="panel-head">
            <span><span class="idx">03</span>Canlı Log</span>
            <span class="muted">GET /admin/logs · 2s</span>
          </header>
          <div class="panel-body">
            <table class="tbl log-tbl">
              <thead>
                <tr>
                  <th>Saat</th>
                  <th>Kod</th>
                  <th>Anahtar</th>
                  <th>Detay</th>
                  <th class="r">Maliyet</th>
                </tr>
              </thead>
              <tbody id="logsTableBody">
                <tr class="empty"><td colspan="5">HENÜZ İSTEK YOK</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  `;
}

function updateReadouts() {
  document.getElementById("ttlReadout").textContent = `${state.ttl} DK`;
  document.getElementById("quotaReadout").textContent = `$${state.budget.toFixed(3)}`;
}

function bindSeg(id, onPick) {
  const seg = document.getElementById(id);
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-val]");
    if (!btn) return;
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    onPick(btn.dataset.val);
  });
}

/* ---------- Keys ---------- */

function statusCell(k) {
  if (k.status === "active") {
    return `<span class="live-dot" aria-hidden="true"></span><span class="ttl" data-expires="${escapeHtml(
      k.expires_at
    )}"></span>`;
  }
  const map = {
    revoked: ["st st-burned", "BURNED"],
    expired: ["st st-dead", "EXPIRED"],
    budget_exceeded: ["st st-quota", "QUOTA"],
  };
  const [cls, label] = map[k.status] || ["st st-dead", String(k.status).toUpperCase()];
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}

function burnButton(k) {
  if (k.is_revoked) {
    return `<button class="burn" type="button" disabled><span>BURNED</span></button>`;
  }
  if (state.burningId === k.id) {
    return `<button class="burn confirm" type="button" disabled><span>BURNING…</span></button>`;
  }
  if (state.pendingBurnId === k.id) {
    return `<button class="burn confirm" type="button" data-burn-id="${k.id}"><span>CONFIRM BURN?</span></button>`;
  }
  return `<button class="burn" type="button" data-burn-id="${k.id}" aria-label="${escapeHtml(
    k.name
  )} anahtarını yak"><span>BURN</span></button>`;
}

function testButton(k) {
  if (k.status !== "active") return "";
  if (!state.rawKeys.has(k.id)) {
    return `<button class="mini" type="button" disabled title="Ham anahtar yalnızca üretildiği anda gösterilir; bu anahtar bu sekmede üretilmedi.">TEST →</button>`;
  }
  return `<button class="mini" type="button" data-test-id="${k.id}" title="Anahtarı simülatöre aktar">TEST →</button>`;
}

function rowHtml(k) {
  const budget = Math.max(Number(k.budget_limit_usd) || 0, 0.000001);
  const spent = Number(k.spent_usd) || 0;
  const pct = Math.min(100, (spent / budget) * 100);
  let on = Math.round((pct / 100) * METER_CELLS);
  if (spent > 0 && on === 0) on = 1;
  const cells = Array.from({ length: METER_CELLS }, (_, i) => `<i class="${i < on ? "on" : ""}"></i>`).join("");
  const provider = k.provider ? ` · ${escapeHtml(String(k.provider).toUpperCase())}` : "";
  const models = (k.allowed_models || []).map(modelLabel).join(" · ");

  return `
    <td class="kcell">
      <div class="k-name" title="${escapeHtml(k.name)}"><span class="k-id">#${String(k.id).padStart(
        3,
        "0"
      )}</span><span class="k-name-text">${escapeHtml(k.name)}</span></div>
      <div class="sub">${escapeHtml(k.key_preview)}${provider}</div>
      <div class="sub tags" title="${escapeHtml(models)}">${escapeHtml(models)}</div>
    </td>
    <td class="nowrap">
      <div class="meter ${pct >= 80 ? "hot" : ""}" title="%${pct.toFixed(1)}">${cells}</div>
      <div class="sub">$${spent.toFixed(4)} / $${budget.toFixed(4)}</div>
      <div class="sub num">${Math.round(pct)}% · ${Number(k.request_count) || 0} İST</div>
    </td>
    <td class="nowrap">${statusCell(k)}</td>
    <td class="r nowrap"><div class="row-actions">${testButton(k)}${burnButton(k)}</div></td>
  `;
}

function sortedKeys() {
  const list = state.filter === "active" ? state.keys.filter((k) => k.status === "active") : state.keys.slice();
  return list.sort((a, b) => {
    const aa = a.status === "active" ? 0 : 1;
    const bb = b.status === "active" ? 0 : 1;
    return aa - bb || b.id - a.id;
  });
}

function renderKeys() {
  const activeCount = state.keys.filter((k) => k.status === "active").length;
  document.getElementById("countActive").textContent = activeCount;
  document.getElementById("countAll").textContent = state.keys.length;

  const tbody = document.getElementById("keysTableBody");
  const list = sortedKeys();

  if (!list.length) {
    rowSigs.clear();
    tbody.innerHTML = `<tr class="empty"><td colspan="4">${
      state.keys.length
        ? `AKTİF ANAHTAR YOK · <button type="button" class="link-btn" data-goto-all>TÜMÜ SEKMESİNE BAKIN</button>`
        : "HENÜZ ANAHTAR YOK · SOLDAN ÜRETİN"
    }</td></tr>`;
    return;
  }

  tbody.querySelectorAll("tr.empty").forEach((tr) => tr.remove());

  // Update rows in place so hover, focus and the BURN confirm state survive the 2s refresh.
  const wanted = new Set(list.map((k) => String(k.id)));
  tbody.querySelectorAll("tr[data-id]").forEach((tr) => {
    if (!wanted.has(tr.dataset.id)) {
      rowSigs.delete(tr.dataset.id);
      tr.remove();
    }
  });

  const rows = list.map((k) => {
    const id = String(k.id);
    let tr = tbody.querySelector(`tr[data-id="${id}"]`);
    if (!tr) {
      tr = document.createElement("tr");
      tr.dataset.id = id;
    }
    const html = rowHtml(k);
    if (rowSigs.get(id) !== html) {
      tr.innerHTML = html;
      rowSigs.set(id, html);
    }
    tr.classList.toggle("is-dead", k.status !== "active");
    return tr;
  });

  const current = Array.from(tbody.children);
  const sameOrder = current.length === rows.length && rows.every((tr, i) => current[i] === tr);
  if (!sameOrder) rows.forEach((tr) => tbody.appendChild(tr));

  tickCountdowns();
}

function tickCountdowns() {
  const now = Date.now();
  document.querySelectorAll("#keysTableBody .ttl[data-expires]").forEach((el) => {
    const left = new Date(el.dataset.expires).getTime() - now;
    const text = formatCountdown(left);
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle("low", left <= 60_000);
  });
}

/* ---------- Logs ---------- */

function renderLogs(logs) {
  const sig = JSON.stringify(logs);
  if (sig === state.logsSig) return;
  state.logsSig = sig;

  const tbody = document.getElementById("logsTableBody");
  if (!logs.length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="5">HENÜZ İSTEK YOK</td></tr>`;
    return;
  }

  tbody.innerHTML = logs
    .map((log) => {
      const ok = log.status_code >= 200 && log.status_code < 300;
      const model = log.model ? modelLabel(log.model) : "-";
      const tokens = `${Number(log.input_tokens) || 0}/${Number(log.output_tokens) || 0} tok`;
      // Success rows show model + tokens; failures show the proxy's reason. Full line in the tooltip.
      const detail = ok ? `${model} · ${tokens}` : log.error_message || "Hata";
      const full = [log.burner_key_name || "-", log.model || "-", tokens, log.error_message || "OK"].join(" · ");
      return `
        <tr title="${escapeHtml(full)}">
          <td class="mono muted">${formatTime(log.created_at)}</td>
          <td><span class="code ${ok ? "" : "err"}">${escapeHtml(log.status_code)}</span></td>
          <td class="trunc-s">${escapeHtml(log.burner_key_name || "-")}</td>
          <td class="trunc ${ok ? "mono muted" : ""}">${escapeHtml(detail)}</td>
          <td class="r mono">$${Number(log.cost_usd || 0).toFixed(5)}</td>
        </tr>
      `;
    })
    .join("");
}

/* ---------- Init ---------- */

export async function initDashboard() {
  const root = document.getElementById("dashboard-root");
  if (!root) return;
  renderShell(root);
  updateReadouts();

  let latestCreatedKey = "";

  bindSeg("ttlSeg", (v) => {
    state.ttl = Number(v);
    updateReadouts();
  });
  bindSeg("quotaSeg", (v) => {
    state.budget = Number(v);
    updateReadouts();
  });
  bindSeg("keyFilter", (v) => {
    state.filter = v;
    renderKeys();
  });

  function updateModelCount() {
    const n = document.querySelectorAll('input[name="allowed_model"]:checked').length;
    document.getElementById("modelCount").textContent = `${n} seçili`;
  }

  async function loadModels() {
    const container = document.getElementById("modelsContainer");
    try {
      const models = await fetchModels();
      container.innerHTML = models
        .map(
          (m, idx) => `
          <label class="opt" title="${escapeHtml(m)}">
            <input type="checkbox" name="allowed_model" value="${escapeHtml(m)}" ${idx === 0 ? "checked" : ""} />
            <span class="box" aria-hidden="true"></span>
            <span class="txt">${escapeHtml(modelLabel(m))}</span>
          </label>`
        )
        .join("");
    } catch {
      container.innerHTML = `<div class="opt"><span class="txt muted">Model listesi yüklenemedi</span></div>`;
    }
    updateModelCount();
  }

  async function loadVaults() {
    const container = document.getElementById("vaultList");
    try {
      const vaults = await fetchMasterKeys();
      if (!vaults.length) {
        container.innerHTML = `<div class="opt"><span class="txt muted">Kasa yok · varsayılan kullanılacak</span></div>`;
        return;
      }
      container.innerHTML = vaults
        .map(
          (v, idx) => `
          <label class="opt" title="${escapeHtml(v.base_url || "")}">
            <input type="radio" name="vault" value="${v.id}" ${idx === 0 ? "checked" : ""} />
            <span class="box" aria-hidden="true"></span>
            <span class="txt">${escapeHtml(v.name)}</span>
            <span class="end">${escapeHtml(v.provider)}</span>
          </label>`
        )
        .join("");
    } catch {
      container.innerHTML = `<div class="opt"><span class="txt muted">Kasa listesi yüklenemedi</span></div>`;
    }
  }

  async function refresh() {
    try {
      const [keys, logs] = await Promise.all([fetchKeys(), fetchLogs(30)]);
      state.keys = keys;
      renderKeys();
      renderLogs(logs);
    } catch (err) {
      console.error("Dashboard refresh error:", err);
    }
  }

  document.getElementById("modelsContainer").addEventListener("change", updateModelCount);

  document.getElementById("createKeyForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("formError");
    const btn = document.getElementById("createKeyBtn");
    errEl.hidden = true;

    const checkedModels = Array.from(document.querySelectorAll('input[name="allowed_model"]:checked')).map(
      (el) => el.value
    );
    if (!checkedModels.length) {
      errEl.textContent = "EN AZ BİR MODEL SEÇİN";
      errEl.hidden = false;
      return;
    }

    const vault = document.querySelector('input[name="vault"]:checked');
    btn.disabled = true;
    try {
      const created = await createKey({
        name: document.getElementById("keyName").value.trim() || "Burner Key",
        budget_limit_usd: state.budget,
        ttl_minutes: state.ttl,
        allowed_models: checkedModels,
        master_key_id: vault ? Number(vault.value) : null,
      });

      latestCreatedKey = created.api_key;
      state.rawKeys.set(created.id, created.api_key);
      document.getElementById("newKeyValue").textContent = latestCreatedKey;
      document.getElementById("newKeyBanner").hidden = false;
      selectKeyInSimulator(latestCreatedKey);
      await refresh();
    } catch (err) {
      errEl.textContent = (err.message || "Anahtar oluşturulamadı").toUpperCase();
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("copyNewKeyBtn").addEventListener("click", async (e) => {
    if (!latestCreatedKey) return;
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(latestCreatedKey);
      btn.textContent = "Kopyalandı";
    } catch {
      btn.textContent = "Kopyalanamadı";
    }
    setTimeout(() => (btn.textContent = "Kopyala"), 1500);
  });

  document.getElementById("sendToSimBtn").addEventListener("click", () => {
    if (!latestCreatedKey) return;
    selectKeyInSimulator(latestCreatedKey);
  });

  document.getElementById("closeBannerBtn").addEventListener("click", () => {
    document.getElementById("newKeyBanner").hidden = true;
  });

  // BURN: first click arms (CONFIRM BURN?), second click within 3s revokes.
  document.getElementById("keysTableBody").addEventListener("click", async (e) => {
    if (e.target.closest("button[data-goto-all]")) {
      const allBtn = document.querySelector('#keyFilter button[data-val="all"]');
      allBtn.click();
      allBtn.focus();
      return;
    }

    const testBtn = e.target.closest("button[data-test-id]");
    if (testBtn) {
      const raw = state.rawKeys.get(Number(testBtn.dataset.testId));
      if (raw) selectKeyInSimulator(raw);
      return;
    }

    const btn = e.target.closest("button[data-burn-id]");
    if (!btn || btn.disabled) return;
    const id = Number(btn.dataset.burnId);
    clearTimeout(state.burnTimer);

    if (state.pendingBurnId !== id) {
      state.pendingBurnId = id;
      state.burnTimer = setTimeout(() => {
        state.pendingBurnId = null;
        renderKeys();
      }, BURN_CONFIRM_MS);
      renderKeys();
      return;
    }

    state.pendingBurnId = null;
    state.burningId = id;
    renderKeys();
    try {
      await revokeKey(id);
    } catch (err) {
      console.error("Revoke failed:", err);
    } finally {
      state.burningId = null;
      await refresh();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.pendingBurnId !== null) {
      clearTimeout(state.burnTimer);
      state.pendingBurnId = null;
      renderKeys();
    }
  });

  window.addEventListener("burner:activity", refresh);

  await Promise.all([loadModels(), loadVaults()]);
  await refresh();
  setInterval(refresh, 2000);
  setInterval(tickCountdowns, 1000);
}
