/**
 * Admin Control Panel: quick key generator, active key list (live TTL countdown,
 * quota meter, BURN kill switch) and live proxy logs.
 * Owner: Kerim
 */

import {
  createKey,
  createMasterKey,
  fetchKeys,
  fetchLogs,
  fetchMasterKeys,
  fetchModels,
  fetchProviders,
  revokeKey,
} from "./api.js";

const EYE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="6.5" y="6.5" width="3" height="3" fill="currentColor"/></svg>`;
const EYE_OFF_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 14L14 2" stroke="currentColor" stroke-width="1.3"/></svg>`;

// Providers offered in "GERÇEK KEY" mode (mock has its own tab; custom needs a base URL).
const LIVE_EXCLUDED = new Set(["mock", "custom"]);

const TTL_OPTIONS = [
  ["15M", 15],
  ["1H", 60],
  ["24H", 1440],
  ["ÖZEL", "custom"],
];

const TTL_UNITS = [
  ["DK", "min", 1],
  ["SAAT", "hour", 60],
  ["GÜN", "day", 1440],
];

const MAX_TTL_MINUTES = 43200;

const QUOTA_OPTIONS = [
  ["$0.005", 0.005],
  ["$0.05", 0.05],
  ["$0.50", 0.5],
  ["$5.00", 5],
  ["ÖZEL", "custom"],
];

const BURN_CONFIRM_MS = 3000;
const METER_CELLS = 20;

const state = {
  ttl: 60,
  ttlCustom: false,
  ttlUnit: "min",
  budget: 0.005,
  budgetCustom: false,
  submitting: false,
  filter: "active",
  keys: [],
  pendingBurnId: null,
  burnTimer: null,
  burningId: null,
  logsSig: "",
  // Raw keys are only returned once by POST /admin/keys, so TEST → works for keys made in this tab.
  rawKeys: new Map(),
  // Vault: "mock" uses the free local mock vault, "live" a real provider master key.
  vaultMode: "mock",
  liveVault: "new", // "new" = key typed into the form, otherwise a saved master key id
  vaults: [],
  providers: [],
  allModels: [],
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
  const total = Math.floor(ms / 1000);
  if (total <= 0) return "DOLDU";
  if (total < 60) return `${total}sn`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}dk ${String(s).padStart(2, "0")}sn`;
  }
  if (total < 86400) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return `${h}sa ${m}dk`;
  }
  const days = Math.floor(total / 86400);
  if (days > 365) {
    const y = Math.floor(days / 365);
    const remDays = days % 365;
    return `${y}y ${remDays}g`;
  }
  const remHours = Math.floor((total % 86400) / 3600);
  return `${days}g ${remHours}sa`;
}

function formatExpiryTooltip(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `Bitiş: ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function formatUsdReadout(val) {
  if (val < 0.001) return `$${Number(val.toFixed(6))}`;
  if (val < 1) return `$${val.toFixed(3)}`;
  return Math.abs(val * 100 - Math.round(val * 100)) < 1e-9
    ? `$${val.toFixed(2)}`
    : `$${val.toFixed(3)}`;
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
            <div class="label"><span>Kasa (Master Key)</span><b id="vaultBadge" class="badge">MOCK</b></div>
            <div id="vaultTabs" class="seg full" role="group" aria-label="Kasa modu">
              <button type="button" data-val="mock" aria-pressed="true">Mock Test</button>
              <button type="button" data-val="live" aria-pressed="false">Gerçek Key</button>
            </div>
            <div id="vaultMockPane" class="vault-pane">
              <div id="vaultList" class="opts one">
                <div class="opt"><span class="txt muted">Yükleniyor…</span></div>
              </div>
            </div>
            <div id="vaultLivePane" class="vault-pane" hidden>
              <div id="liveSaved" class="opts one"></div>
              <div id="liveNewRow" class="live-new">
                <select id="liveProvider" class="select" aria-label="Sağlayıcı"></select>
                <div class="secret-row">
                  <input
                    id="liveKey"
                    class="input mono"
                    type="password"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="Master API key"
                    aria-label="Gerçek master API key"
                  />
                  <button id="liveKeyEye" class="eye" type="button" aria-label="Anahtarı göster" aria-pressed="false">${EYE_ICON}</button>
                </div>
              </div>
              <p class="hint">Key yerel backend'de şifrelenip saklanır, tarayıcıda tutulmaz. Gerçek key ile yapılan istekler kredi harcar.</p>
            </div>
          </div>

          <div class="field">
            <div class="label"><span>Süre (TTL)</span><b id="ttlReadout"></b></div>
            <div id="ttlSeg" class="seg full" role="group" aria-label="Süre">
              ${segButtons(TTL_OPTIONS, state.ttlCustom ? "custom" : state.ttl)}
            </div>
            <div id="ttlCustomRow" class="custom-row" hidden>
              <input
                id="ttlCustomVal"
                class="custom-num mono"
                type="number"
                min="1"
                step="1"
                value="30"
                inputmode="numeric"
                aria-label="Özel süre değeri"
              />
              <div id="ttlUnitSeg" class="seg custom-units" role="group" aria-label="Süre birimi">
                ${TTL_UNITS.map(
                  ([label, key]) =>
                    `<button type="button" data-val="${key}" aria-pressed="${key === state.ttlUnit}">${label}</button>`
                ).join("")}
              </div>
            </div>
          </div>

          <div class="field">
            <div class="label"><span>Kota (USD)</span><b id="quotaReadout"></b></div>
            <div id="quotaSeg" class="seg full compact" role="group" aria-label="Kota">
              ${segButtons(QUOTA_OPTIONS, state.budgetCustom ? "custom" : state.budget)}
            </div>
            <div id="quotaCustomRow" class="custom-row custom-row-prefix" hidden>
              <span class="custom-prefix" aria-hidden="true">$</span>
              <input
                id="quotaCustomVal"
                class="custom-num mono"
                type="number"
                step="0.001"
                min="0.001"
                placeholder="0.25"
                inputmode="decimal"
                aria-label="Özel kota tutarı (USD)"
              />
            </div>
          </div>

          <div class="field">
            <div class="label">
              <span>İzinli Modeller</span>
              <span class="label-end">
                <b id="modelCount">0 seçili</b>
                <button id="modelToggle" type="button" class="tiny">Hepsini seç</button>
              </span>
            </div>
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

function getResolvedTtl() {
  if (!state.ttlCustom) {
    return { valid: true, minutes: state.ttl, readout: `${state.ttl} DK` };
  }
  const input = document.getElementById("ttlCustomVal");
  const raw = input ? input.value.trim() : "";
  if (!raw) {
    return { valid: false, minutes: null, readout: "GEÇERSİZ" };
  }
  const val = Number(raw);
  if (!Number.isFinite(val) || val <= 0 || !Number.isInteger(val)) {
    return { valid: false, minutes: null, readout: "GEÇERSİZ" };
  }
  const [unitLabel, , multiplier] = TTL_UNITS.find(([, key]) => key === state.ttlUnit) || TTL_UNITS[0];
  const minutes = val * multiplier;
  if (minutes > MAX_TTL_MINUTES) {
    return { valid: false, minutes: null, readout: "MAX 30 GÜN" };
  }
  const readout = state.ttlUnit === "min" ? `${val} DK` : `${val} ${unitLabel} (${minutes} DK)`;
  return { valid: true, minutes, readout };
}

function getResolvedBudget() {
  if (!state.budgetCustom) {
    return { valid: true, budget: state.budget, readout: `$${state.budget.toFixed(3)}` };
  }
  const input = document.getElementById("quotaCustomVal");
  const raw = input ? input.value.trim() : "";
  if (!raw) {
    return { valid: false, budget: null, readout: "TUTAR GİRİN" };
  }
  const val = Number(raw);
  if (!Number.isFinite(val) || val <= 0) {
    return { valid: false, budget: null, readout: "GEÇERSİZ" };
  }
  return { valid: true, budget: val, readout: formatUsdReadout(val) };
}

function syncCustomControls() {
  const ttlRow = document.getElementById("ttlCustomRow");
  const quotaRow = document.getElementById("quotaCustomRow");
  const ttlReadout = document.getElementById("ttlReadout");
  const quotaReadout = document.getElementById("quotaReadout");
  const btn = document.getElementById("createKeyBtn");

  ttlRow.hidden = !state.ttlCustom;
  quotaRow.hidden = !state.budgetCustom;

  const ttlInfo = getResolvedTtl();
  const budgetInfo = getResolvedBudget();

  ttlReadout.textContent = ttlInfo.readout;
  ttlReadout.classList.toggle("is-invalid", !ttlInfo.valid);
  ttlRow.classList.toggle("is-invalid", state.ttlCustom && !ttlInfo.valid);

  quotaReadout.textContent = budgetInfo.readout;
  quotaReadout.classList.toggle("is-invalid", !budgetInfo.valid);
  quotaRow.classList.toggle("is-invalid", state.budgetCustom && !budgetInfo.valid);

  btn.disabled = state.submitting || !ttlInfo.valid || !budgetInfo.valid;
  btn.classList.toggle("is-busy", state.submitting);
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
  const expiryTitle = formatExpiryTooltip(k.expires_at);

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
    <td class="nowrap"${expiryTitle ? ` title="${escapeHtml(expiryTitle)}"` : ""}>${statusCell(k)}</td>
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

  tickCountdowns(true);
}

function tickCountdowns(force = false) {
  const now = Date.now();
  document.querySelectorAll("#keysTableBody .ttl[data-expires]").forEach((el) => {
    if (!force && el.dataset.nextTick && now < Number(el.dataset.nextTick)) {
      return;
    }
    const expiresMs = new Date(el.dataset.expires).getTime();
    const left = expiresMs - now;
    const text = formatCountdown(left);
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle("low", left <= 60_000);

    if (left < 3_600_000) {
      delete el.dataset.nextTick;
    } else if (left < 86_400_000) {
      const remMs = left % 60_000 || 60_000;
      el.dataset.nextTick = String(now + Math.min(remMs, left - 3_599_000));
    } else {
      const remMs = left % 3_600_000 || 3_600_000;
      el.dataset.nextTick = String(now + Math.min(remMs, left - 86_399_000));
    }
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
  syncCustomControls();

  let latestCreatedKey = "";

  bindSeg("ttlSeg", (v) => {
    if (v === "custom") {
      state.ttlCustom = true;
      syncCustomControls();
      const input = document.getElementById("ttlCustomVal");
      input.focus();
      input.select();
    } else {
      state.ttlCustom = false;
      state.ttl = Number(v);
      syncCustomControls();
    }
  });
  bindSeg("ttlUnitSeg", (v) => {
    state.ttlUnit = v;
    syncCustomControls();
  });
  bindSeg("quotaSeg", (v) => {
    if (v === "custom") {
      state.budgetCustom = true;
      syncCustomControls();
      const input = document.getElementById("quotaCustomVal");
      input.focus();
      input.select();
    } else {
      state.budgetCustom = false;
      state.budget = Number(v);
      syncCustomControls();
    }
  });
  bindSeg("keyFilter", (v) => {
    state.filter = v;
    renderKeys();
  });

  ["ttlCustomVal", "quotaCustomVal"].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener("input", syncCustomControls);
    el.addEventListener("change", syncCustomControls);
  });

  /* ----- Models + select-all toggle ----- */

  function modelInputs() {
    return Array.from(document.querySelectorAll('input[name="allowed_model"]'));
  }

  function updateModelCount() {
    const inputs = modelInputs();
    const n = inputs.filter((el) => el.checked).length;
    document.getElementById("modelCount").textContent = `${n} seçili`;
    const toggle = document.getElementById("modelToggle");
    const allOn = inputs.length > 0 && n === inputs.length;
    toggle.textContent = allOn ? "Hepsini kaldır" : "Hepsini seç";
    toggle.disabled = inputs.length === 0;
  }

  function renderModels(models) {
    const container = document.getElementById("modelsContainer");
    const previously = new Set(modelInputs().filter((el) => el.checked).map((el) => el.value));
    if (!models.length) {
      container.innerHTML = `<div class="opt"><span class="txt muted">Model yok</span></div>`;
      updateModelCount();
      return;
    }
    let keep = models.filter((m) => previously.has(m));
    if (!keep.length) keep = [models[0]];
    const checked = new Set(keep);
    container.innerHTML = models
      .map(
        (m) => `
        <label class="opt" title="${escapeHtml(m)}">
          <input type="checkbox" name="allowed_model" value="${escapeHtml(m)}" ${checked.has(m) ? "checked" : ""} />
          <span class="box" aria-hidden="true"></span>
          <span class="txt">${escapeHtml(modelLabel(m))}</span>
        </label>`
      )
      .join("");
    updateModelCount();
  }

  async function loadModels() {
    try {
      state.allModels = await fetchModels();
    } catch {
      state.allModels = [];
      document.getElementById("modelsContainer").innerHTML =
        `<div class="opt"><span class="txt muted">Model listesi yüklenemedi</span></div>`;
      updateModelCount();
      return;
    }
    renderModelsForVault();
  }

  document.getElementById("modelToggle").addEventListener("click", () => {
    const inputs = modelInputs();
    const allOn = inputs.every((el) => el.checked);
    inputs.forEach((el) => (el.checked = !allOn));
    updateModelCount();
  });

  /* ----- Vault: MOCK TEST | GERÇEK KEY ----- */

  const isMockVault = (v) => v.provider === "mock" || v.protocol === "mock";

  function liveProviderId() {
    if (state.liveVault === "new") return document.getElementById("liveProvider").value;
    const saved = state.vaults.find((v) => String(v.id) === String(state.liveVault));
    return saved ? saved.provider : "";
  }

  function liveReady() {
    if (state.liveVault !== "new") return true;
    return document.getElementById("liveKey").value.trim().length > 0;
  }

  function renderModelsForVault() {
    if (state.vaultMode === "live") {
      const provider = state.providers.find((p) => p.id === liveProviderId());
      renderModels(provider ? provider.models : state.allModels);
    } else {
      renderModels(state.allModels);
    }
  }

  function syncVaultUi() {
    const live = state.vaultMode === "live";
    document.getElementById("vaultMockPane").hidden = live;
    document.getElementById("vaultLivePane").hidden = !live;

    const isNew = state.liveVault === "new";
    const newRow = document.getElementById("liveNewRow");
    newRow.classList.toggle("is-off", !isNew);
    document.getElementById("liveProvider").disabled = !isNew;
    document.getElementById("liveKey").disabled = !isNew;
    document.getElementById("liveKeyEye").disabled = !isNew;

    const provider = state.providers.find((p) => p.id === document.getElementById("liveProvider").value);
    document.getElementById("liveKey").placeholder = provider?.key_hint ? `${provider.key_hint}` : "Master API key";

    const badge = document.getElementById("vaultBadge");
    if (!live) {
      badge.textContent = "MOCK";
      badge.className = "badge";
    } else if (liveReady()) {
      badge.textContent = "● LIVE";
      badge.className = "badge badge-live";
    } else {
      badge.textContent = "KEY BEKLENİYOR";
      badge.className = "badge badge-wait";
    }
  }

  function renderVaults() {
    const mockVaults = state.vaults.filter(isMockVault);
    const liveVaults = state.vaults.filter((v) => !isMockVault(v));
    const mockContainer = document.getElementById("vaultList");
    const checkedMock = document.querySelector('input[name="vault"]:checked')?.value;

    mockContainer.innerHTML = mockVaults.length
      ? mockVaults
          .map(
            (v, idx) => `
          <label class="opt" title="${escapeHtml(v.base_url || "")}">
            <input type="radio" name="vault" value="${v.id}" ${
              String(v.id) === checkedMock || (!checkedMock && idx === 0) ? "checked" : ""
            } />
            <span class="box" aria-hidden="true"></span>
            <span class="txt">${escapeHtml(v.name)}</span>
            <span class="end">${escapeHtml(v.provider)}</span>
          </label>`
          )
          .join("")
      : `<div class="opt"><span class="txt muted">Mock kasa yok · varsayılan kullanılacak</span></div>`;

    if (state.liveVault !== "new" && !liveVaults.some((v) => String(v.id) === String(state.liveVault))) {
      state.liveVault = "new";
    }
    const savedRows = liveVaults
      .map(
        (v) => `
        <label class="opt" title="${escapeHtml(v.base_url || "")}">
          <input type="radio" name="liveVault" value="${v.id}" ${String(v.id) === String(state.liveVault) ? "checked" : ""} />
          <span class="box" aria-hidden="true"></span>
          <span class="txt">${escapeHtml(v.name)} <span class="muted">${escapeHtml(v.key_preview)}</span></span>
          <span class="end">${escapeHtml(v.provider)}</span>
        </label>`
      )
      .join("");
    document.getElementById("liveSaved").innerHTML = `
      <label class="opt">
        <input type="radio" name="liveVault" value="new" ${state.liveVault === "new" ? "checked" : ""} />
        <span class="box" aria-hidden="true"></span>
        <span class="txt">Yeni key gir</span>
        <span class="end">${liveVaults.length ? `${liveVaults.length} kayıtlı` : ""}</span>
      </label>${savedRows}`;
    syncVaultUi();
  }

  async function loadVaults() {
    try {
      state.vaults = await fetchMasterKeys();
    } catch {
      state.vaults = [];
      document.getElementById("vaultList").innerHTML =
        `<div class="opt"><span class="txt muted">Kasa listesi yüklenemedi</span></div>`;
      return;
    }
    renderVaults();
  }

  async function loadProviders() {
    try {
      state.providers = (await fetchProviders()).filter((p) => !LIVE_EXCLUDED.has(p.id));
    } catch {
      state.providers = [];
    }
    const select = document.getElementById("liveProvider");
    select.innerHTML = state.providers
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
      .join("");
    if (state.providers.some((p) => p.id === "anthropic")) select.value = "anthropic";
    syncVaultUi();
  }

  bindSeg("vaultTabs", (v) => {
    state.vaultMode = v;
    syncVaultUi();
    renderModelsForVault();
  });

  document.getElementById("liveSaved").addEventListener("change", (e) => {
    if (e.target.name !== "liveVault") return;
    state.liveVault = e.target.value;
    syncVaultUi();
    renderModelsForVault();
  });

  document.getElementById("liveProvider").addEventListener("change", () => {
    syncVaultUi();
    renderModelsForVault();
  });

  document.getElementById("liveKey").addEventListener("input", syncVaultUi);

  document.getElementById("liveKeyEye").addEventListener("click", (e) => {
    const input = document.getElementById("liveKey");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    const btn = e.currentTarget;
    btn.innerHTML = show ? EYE_OFF_ICON : EYE_ICON;
    btn.setAttribute("aria-pressed", String(show));
    btn.setAttribute("aria-label", show ? "Anahtarı gizle" : "Anahtarı göster");
  });

  // Returns the master_key_id for the new burner key (creating a live vault entry if needed).
  async function resolveMasterKeyId() {
    if (state.vaultMode === "mock") {
      const vault = document.querySelector('input[name="vault"]:checked');
      return vault ? Number(vault.value) : null;
    }
    if (state.liveVault !== "new") return Number(state.liveVault);

    const input = document.getElementById("liveKey");
    const raw = input.value.trim();
    if (!raw) throw new Error("GERÇEK MASTER KEY GİRİN VEYA KAYITLI BİR KASA SEÇİN");
    const providerId = document.getElementById("liveProvider").value;
    const provider = state.providers.find((p) => p.id === providerId);
    const master = await createMasterKey({
      name: `${provider ? provider.name : providerId} · Live`,
      provider: providerId,
      api_key: raw,
    });
    // Never keep the secret around in the page once it is stored server-side.
    input.value = "";
    input.type = "password";
    state.liveVault = String(master.id);
    await loadVaults();
    renderModelsForVault();
    return master.id;
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
    errEl.hidden = true;

    const ttlInfo = getResolvedTtl();
    const budgetInfo = getResolvedBudget();
    if (!ttlInfo.valid || !budgetInfo.valid) {
      errEl.textContent = !ttlInfo.valid
        ? "GEÇERLİ BİR SÜRE GİRİN (1 DK – 30 GÜN)"
        : "GEÇERLİ BİR KOTA TUTARI GİRİN (> $0)";
      errEl.hidden = false;
      syncCustomControls();
      return;
    }

    const checkedModels = Array.from(document.querySelectorAll('input[name="allowed_model"]:checked')).map(
      (el) => el.value
    );
    if (!checkedModels.length) {
      errEl.textContent = "EN AZ BİR MODEL SEÇİN";
      errEl.hidden = false;
      return;
    }

    state.submitting = true;
    syncCustomControls();
    try {
      const masterKeyId = await resolveMasterKeyId();
      const created = await createKey({
        name: document.getElementById("keyName").value.trim() || "Burner Key",
        budget_limit_usd: budgetInfo.budget,
        ttl_minutes: ttlInfo.minutes,
        allowed_models: checkedModels,
        master_key_id: masterKeyId,
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
      state.submitting = false;
      syncCustomControls();
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

  await Promise.all([loadProviders(), loadVaults()]);
  await loadModels();
  await refresh();
  setInterval(refresh, 2000);
  setInterval(() => tickCountdowns(false), 1000);
}
