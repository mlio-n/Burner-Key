/**
 * Admin Control Panel: key creation, spend progress bars, Kill Switch, and live logs.
 * Owner: Kerim
 */

import {
  createKey,
  fetchKeys,
  fetchLogs,
  fetchModels,
  revokeKey,
} from "./api.js";

const STATUS_STYLES = {
  active: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
  revoked: "border-rose-500/40 bg-rose-500/15 text-rose-300",
  expired: "border-amber-500/40 bg-amber-500/15 text-amber-300",
  budget_exceeded: "border-orange-500/40 bg-orange-500/15 text-orange-300",
};

const STATUS_LABELS = {
  active: "AKTİF",
  revoked: "İPTAL (REVOKED)",
  expired: "SÜRESİ DOLDU",
  budget_exceeded: "BÜTÇE DOLDU",
};

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleTimeString("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function renderShell(root) {
  root.innerHTML = `
    <div class="space-y-5">
      <!-- One-time Created Key Alert -->
      <section id="newKeyBanner" class="hidden rounded-xl border-2 border-emerald-500/60 bg-emerald-950/40 p-4 shadow-lg">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0 flex-1">
            <p class="text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
              Yeni Burner Key Oluşturuldu (Tek seferlik gösterim — şimdi kopyalayın)
            </p>
            <code id="newKeyValue" class="mt-1.5 block truncate rounded-lg border border-emerald-500/30 bg-slate-950 px-3 py-2 font-mono text-xs font-bold text-emerald-300"></code>
          </div>
          <div class="flex items-center gap-2">
            <button id="copyNewKeyBtn" type="button" class="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 transition">
              Kopyala
            </button>
            <button id="sendToSimBtn" type="button" class="rounded-lg border border-sky-500/40 bg-sky-500/15 px-3 py-2 text-xs font-semibold text-sky-300 hover:bg-sky-500/25 transition">
              Simülatöre Gönder →
            </button>
            <button id="closeBannerBtn" type="button" class="rounded-lg border border-slate-700 px-2.5 py-2 text-xs text-slate-300 hover:bg-slate-800">
              Kapat
            </button>
          </div>
        </div>
      </section>

      <!-- Create Key Form -->
      <section class="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
        <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-200 mb-3">
          Yeni Geçici Anahtar Üret
        </h2>

        <form id="createKeyForm" class="space-y-3 text-xs">
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label class="block text-slate-400 mb-1">Uygulama / Anahtar Adı</label>
              <input
                id="keyName"
                type="text"
                required
                value="Cursor BYOK Demo"
                class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label class="block text-slate-400 mb-1">Bütçe Limiti ($)</label>
              <input
                id="budgetLimit"
                type="number"
                step="0.001"
                min="0.0001"
                required
                value="0.005"
                class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-slate-100 focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label class="block text-slate-400 mb-1">Süre / TTL (Dakika)</label>
              <input
                id="ttlMinutes"
                type="number"
                min="1"
                required
                value="60"
                class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-slate-100 focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label class="block text-slate-400 mb-1.5">İzinli Claude Modelleri</label>
            <div id="modelsContainer" class="flex flex-wrap gap-2"></div>
          </div>

          <div class="flex items-center justify-between gap-3 pt-1">
            <p id="formError" class="hidden text-rose-400 text-xs"></p>
            <button
              type="submit"
              class="ml-auto rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 transition shadow"
            >
              + Burner Key Oluştur
            </button>
          </div>
        </form>
      </section>

      <!-- Keys Table -->
      <section class="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-200">
            Aktif ve Geçmiş Anahtarlar
          </h2>
          <span id="keyCount" class="rounded-full bg-slate-800 px-2.5 py-0.5 text-[11px] text-slate-300">
            0 anahtar
          </span>
        </div>

        <div class="overflow-x-auto custom-scroll">
          <table class="w-full text-left text-xs">
            <thead>
              <tr class="border-b border-slate-800 text-slate-400">
                <th class="py-2 pr-3 font-medium">Ad / Önizleme</th>
                <th class="py-2 pr-3 font-medium">Durum</th>
                <th class="py-2 pr-3 font-medium w-44">Harcama / Bütçe</th>
                <th class="py-2 pr-3 font-medium">İstek</th>
                <th class="py-2 pr-3 font-medium">Modeller</th>
                <th class="py-2 font-medium text-right">Kill Switch</th>
              </tr>
            </thead>
            <tbody id="keysTableBody" class="divide-y divide-slate-800/70">
              <tr><td colspan="6" class="py-6 text-center text-slate-500">Yükleniyor...</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Live Logs -->
      <section class="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-200">
            Canlı Proxy Logları
          </h2>
          <span class="text-[11px] text-slate-400">2 sn otomatik yenileme</span>
        </div>

        <div class="overflow-x-auto custom-scroll max-h-64">
          <table class="w-full text-left text-xs">
            <thead>
              <tr class="border-b border-slate-800 text-slate-400">
                <th class="py-2 pr-3 font-medium">Saat</th>
                <th class="py-2 pr-3 font-medium">Anahtar</th>
                <th class="py-2 pr-3 font-medium">Model</th>
                <th class="py-2 pr-3 font-medium">Durum</th>
                <th class="py-2 pr-3 font-medium">Token</th>
                <th class="py-2 pr-3 font-medium">Maliyet</th>
                <th class="py-2 font-medium">Detay</th>
              </tr>
            </thead>
            <tbody id="logsTableBody" class="divide-y divide-slate-800/70">
              <tr><td colspan="7" class="py-5 text-center text-slate-500">Henüz istek yok.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;
}

function renderKeys(keys) {
  document.getElementById("keyCount").textContent = `${keys.length} anahtar`;
  const tbody = document.getElementById("keysTableBody");

  if (!keys.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-6 text-center text-slate-500">
          Henüz burner key yok. Yukarıdaki formdan ilk anahtarı oluşturun.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = keys
    .map((k) => {
      const pct = Math.min(100, (k.spent_usd / Math.max(k.budget_limit_usd, 0.000001)) * 100);
      const barColor =
        pct >= 80 ? "bg-rose-500" : pct >= 60 ? "bg-amber-500" : "bg-emerald-500";
      const nearLimitBadge =
        pct >= 80 && k.status === "active"
          ? `<span class="ml-1 rounded bg-amber-500/20 px-1 py-0.5 text-[10px] text-amber-300">%80+</span>`
          : "";

      return `
        <tr class="hover:bg-slate-800/30">
          <td class="py-2.5 pr-3">
            <div class="font-semibold text-slate-100">${escapeHtml(k.name)}</div>
            <div class="font-mono text-[11px] text-slate-400">${escapeHtml(k.key_preview)}</div>
            <div class="text-[10px] text-slate-500">Bitiş: ${formatTime(k.expires_at)}</div>
          </td>
          <td class="py-2.5 pr-3">
            <span class="inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
              STATUS_STYLES[k.status] || STATUS_STYLES.active
            }">
              ${STATUS_LABELS[k.status] || escapeHtml(k.status)}
            </span>
          </td>
          <td class="py-2.5 pr-3">
            <div class="flex justify-between font-mono text-[11px] mb-1">
              <span>$${Number(k.spent_usd).toFixed(4)}</span>
              <span class="text-slate-400">/ $${Number(k.budget_limit_usd).toFixed(4)}${nearLimitBadge}</span>
            </div>
            <div class="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
              <div class="h-full ${barColor} transition-all duration-300" style="width: ${pct}%"></div>
            </div>
          </td>
          <td class="py-2.5 pr-3 font-mono text-slate-300">${k.request_count}</td>
          <td class="py-2.5 pr-3">
            <div class="flex flex-wrap gap-1">
              ${k.allowed_models
                .map(
                  (m) =>
                    `<span class="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">${escapeHtml(
                      m.replace(/-\d{8}$/, "")
                    )}</span>`
                )
                .join("")}
            </div>
          </td>
          <td class="py-2.5 text-right">
            <button
              data-revoke-id="${k.id}"
              ${k.is_revoked ? "disabled" : ""}
              class="rounded-lg border border-rose-500/40 bg-rose-600/90 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-rose-500 disabled:border-slate-700 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed transition"
            >
              ${k.is_revoked ? "Yakıldı" : "İptal Et"}
            </button>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderLogs(logs) {
  const tbody = document.getElementById("logsTableBody");
  if (!logs.length) {
    tbody.innerHTML = `
      <tr><td colspan="7" class="py-5 text-center text-slate-500">Henüz istek kaydı yok.</td></tr>
    `;
    return;
  }

  tbody.innerHTML = logs
    .map((log) => {
      const ok = log.status_code === 200;
      return `
        <tr class="hover:bg-slate-800/30">
          <td class="py-2 pr-3 font-mono text-slate-400">${formatTime(log.created_at)}</td>
          <td class="py-2 pr-3 text-slate-200">${escapeHtml(log.burner_key_name || "-")}</td>
          <td class="py-2 pr-3 font-mono text-slate-300">${escapeHtml(log.model || "-")}</td>
          <td class="py-2 pr-3">
            <span class="rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${
              ok ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"
            }">
              ${log.status_code}
            </span>
          </td>
          <td class="py-2 pr-3 font-mono text-slate-400">${log.input_tokens}/${log.output_tokens}</td>
          <td class="py-2 pr-3 font-mono text-slate-300">$${Number(log.cost_usd).toFixed(5)}</td>
          <td class="py-2 text-slate-400">${escapeHtml(log.error_message || "OK")}</td>
        </tr>
      `;
    })
    .join("");
}

export async function initDashboard() {
  const root = document.getElementById("dashboard-root");
  if (!root) return;
  renderShell(root);

  let latestCreatedKey = "";

  async function loadModels() {
    try {
      const models = await fetchModels();
      const container = document.getElementById("modelsContainer");
      container.innerHTML = models
        .map(
          (m, idx) => `
          <label class="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 cursor-pointer hover:border-slate-500">
            <input
              type="checkbox"
              name="allowed_model"
              value="${escapeHtml(m)}"
              ${idx === 0 ? "checked" : ""}
              class="rounded border-slate-600 bg-slate-900 text-emerald-500 focus:ring-0"
            />
            <span class="font-mono text-[11px] text-slate-200">${escapeHtml(m)}</span>
          </label>
        `
        )
        .join("");
    } catch {
      document.getElementById("modelsContainer").innerHTML =
        `<span class="text-rose-400">Model listesi yüklenemedi (Backend kapalı olabilir).</span>`;
    }
  }

  async function refresh() {
    try {
      const [keys, logs] = await Promise.all([fetchKeys(), fetchLogs(30)]);
      renderKeys(keys);
      renderLogs(logs);
    } catch (err) {
      console.error("Dashboard refresh error:", err);
    }
  }

  document.getElementById("createKeyForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("formError");
    errEl.classList.add("hidden");

    const checkedModels = Array.from(
      document.querySelectorAll('input[name="allowed_model"]:checked')
    ).map((el) => el.value);

    if (!checkedModels.length) {
      errEl.textContent = "En az bir model seçmelisiniz.";
      errEl.classList.remove("hidden");
      return;
    }

    try {
      const created = await createKey({
        name: document.getElementById("keyName").value,
        budget_limit_usd: Number(document.getElementById("budgetLimit").value),
        ttl_minutes: Number(document.getElementById("ttlMinutes").value),
        allowed_models: checkedModels,
      });

      latestCreatedKey = created.api_key;
      document.getElementById("newKeyValue").textContent = latestCreatedKey;
      document.getElementById("newKeyBanner").classList.remove("hidden");
      window.dispatchEvent(
        new CustomEvent("burner:select-key", { detail: { apiKey: latestCreatedKey } })
      );
      await refresh();
    } catch (err) {
      errEl.textContent = err.message || "Anahtar oluşturulamadı.";
      errEl.classList.remove("hidden");
    }
  });

  document.getElementById("copyNewKeyBtn").addEventListener("click", async () => {
    if (!latestCreatedKey) return;
    await navigator.clipboard.writeText(latestCreatedKey);
    const btn = document.getElementById("copyNewKeyBtn");
    btn.textContent = "Kopyalandı!";
    setTimeout(() => (btn.textContent = "Kopyala"), 1500);
  });

  document.getElementById("sendToSimBtn").addEventListener("click", () => {
    if (!latestCreatedKey) return;
    window.dispatchEvent(
      new CustomEvent("burner:select-key", { detail: { apiKey: latestCreatedKey } })
    );
  });

  document.getElementById("closeBannerBtn").addEventListener("click", () => {
    document.getElementById("newKeyBanner").classList.add("hidden");
  });

  document.getElementById("keysTableBody").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-revoke-id]");
    if (!btn || btn.disabled) return;
    const id = Number(btn.dataset.revokeId);
    await revokeKey(id);
    await refresh();
  });

  window.addEventListener("burner:activity", refresh);

  await loadModels();
  await refresh();
  setInterval(refresh, 2000);
}
