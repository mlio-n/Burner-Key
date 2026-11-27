/**
 * Thin API client shared by dashboard.js and simulator.js.
 * Works both when served from FastAPI (:8000) and standalone static server (:5173, Live Server).
 */

export const API_BASE =
  window.location.port === "8000" ? "" : "http://127.0.0.1:8000";

async function requestJson(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.detail || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export function fetchHealth() {
  return requestJson("/health");
}

export function fetchModels() {
  return requestJson("/admin/models");
}

export function fetchMasterKeys() {
  return requestJson("/admin/master-keys");
}

export function fetchKeys() {
  return requestJson("/admin/keys");
}

export function createKey(payload) {
  return requestJson("/admin/keys", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function revokeKey(id) {
  return requestJson(`/admin/keys/${id}/revoke`, {
    method: "POST",
  });
}

export function fetchLogs(limit = 30) {
  return requestJson(`/admin/logs?limit=${limit}`);
}

export async function sendMessage(apiKey, model, message, extraBody = {}) {
  const res = await fetch(`${API_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: message }],
      ...extraBody,
    }),
  });

  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
