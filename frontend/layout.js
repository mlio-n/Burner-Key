/**
 * Page chrome: theme toggle (light / industrial dark) and drag-to-resize column dividers.
 * Owner: Utku
 */

const THEME_KEY = "burner:theme";
const COLS_KEY = "burner:cols";

// Column widths in % of the workspace (generator / keys+log / simulator).
const DEFAULT_COLS = { gen: 23, mid: 35, sim: 42 };
const MIN = { gen: 18, mid: 25, sim: 25 };
const WIDE_QUERY = window.matchMedia("(min-width: 1280px)");

function readStore(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: setting just isn't remembered
  }
}

/* ---------- Theme ---------- */

function setupTheme() {
  const buttons = document.querySelectorAll("button[data-theme-set]");

  function apply(theme) {
    if (theme === "dark") document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeSet === theme)));
  }

  apply(readStore(THEME_KEY) === "dark" ? "dark" : "light");
  buttons.forEach((b) =>
    b.addEventListener("click", () => {
      apply(b.dataset.themeSet);
      writeStore(THEME_KEY, b.dataset.themeSet);
    })
  );
}

/* ---------- Resizable columns ---------- */

function loadCols() {
  try {
    const c = JSON.parse(readStore(COLS_KEY) || "null");
    if (c && [c.gen, c.mid, c.sim].every(Number.isFinite)) return clampAll(c);
  } catch {
    // fall through to defaults
  }
  return { ...DEFAULT_COLS };
}

function clampAll(c) {
  const gen = Math.max(MIN.gen, c.gen);
  const sim = Math.max(MIN.sim, c.sim);
  const mid = 100 - gen - sim;
  if (mid < MIN.mid) return { ...DEFAULT_COLS };
  return { gen, mid, sim };
}

function setupResizers() {
  const ws = document.getElementById("workspace");
  const dashCol = document.getElementById("dashboard-col");
  const handles = Array.from(document.querySelectorAll(".col-resizer"));
  if (!ws || handles.length !== 2) return;

  let cols = loadCols();
  let frame = 0;

  const isActive = () => document.body.dataset.view === "split" && WIDE_QUERY.matches;
  const dash = () => document.querySelector("#dashboard-root .dash");
  const genPanel = () => document.querySelector("#dashboard-root .dash > .panel-tool");

  function position() {
    const gp = genPanel();
    if (!isActive() || !gp) return;
    const wsRect = ws.getBoundingClientRect();
    const half = parseFloat(getComputedStyle(ws).columnGap || "8") / 2;
    handles[0].style.left = `${gp.getBoundingClientRect().right - wsRect.left + half}px`;
    handles[1].style.left = `${dashCol.getBoundingClientRect().right - wsRect.left + half}px`;
    handles[0].setAttribute("aria-valuenow", String(Math.round(cols.gen)));
    handles[1].setAttribute("aria-valuenow", String(Math.round(cols.gen + cols.mid)));
  }

  function apply() {
    const active = isActive();
    const d = dash();
    ws.style.gridTemplateColumns = active
      ? `minmax(0, ${cols.gen + cols.mid}fr) minmax(0, ${cols.sim}fr)`
      : "";
    if (d) d.style.gridTemplateColumns = active ? `minmax(0, ${cols.gen}fr) minmax(0, ${cols.mid}fr)` : "";
    handles.forEach((h) => (h.hidden = !active));
    position();
  }

  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(apply);
  }

  // which = 0: generator | middle, which = 1: middle | simulator. pct = boundary position in %.
  function moveBoundary(which, pct) {
    if (which === 0) {
      const gen = Math.min(Math.max(pct, MIN.gen), 100 - cols.sim - MIN.mid);
      cols = { gen, mid: 100 - cols.sim - gen, sim: cols.sim };
    } else {
      const edge = Math.min(Math.max(pct, cols.gen + MIN.mid), 100 - MIN.sim);
      cols = { gen: cols.gen, mid: edge - cols.gen, sim: 100 - edge };
    }
    schedule();
  }

  function pctFromClientX(clientX) {
    const rect = ws.getBoundingClientRect();
    const style = getComputedStyle(ws);
    const left = rect.left + parseFloat(style.paddingLeft);
    const width = rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return ((clientX - left) / width) * 100;
  }

  handles.forEach((handle, which) => {
    handle.addEventListener("pointerdown", (e) => {
      if (!isActive() || e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("is-dragging");
      document.body.classList.add("is-resizing");

      const onMove = (ev) => moveBoundary(which, pctFromClientX(ev.clientX));
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        handle.classList.remove("is-dragging");
        document.body.classList.remove("is-resizing");
        writeStore(COLS_KEY, JSON.stringify(cols));
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });

    // Keyboard: ←/→ moves 1% (Shift: 5%), Home resets.
    handle.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 5 : 1;
      const current = which === 0 ? cols.gen : cols.gen + cols.mid;
      if (e.key === "ArrowLeft") moveBoundary(which, current - step);
      else if (e.key === "ArrowRight") moveBoundary(which, current + step);
      else if (e.key === "Home") cols = { ...DEFAULT_COLS };
      else return;
      e.preventDefault();
      schedule();
      writeStore(COLS_KEY, JSON.stringify(cols));
    });

    // Double-click resets to the default proportions.
    handle.addEventListener("dblclick", () => {
      cols = { ...DEFAULT_COLS };
      schedule();
      writeStore(COLS_KEY, JSON.stringify(cols));
    });
  });

  new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
  WIDE_QUERY.addEventListener("change", schedule);
  window.addEventListener("resize", schedule);
  new ResizeObserver(() => position()).observe(ws);

  // dashboard.js renders .dash asynchronously; apply once it exists.
  const waitForDash = () => (dash() ? apply() : requestAnimationFrame(waitForDash));
  waitForDash();
}

export function initLayout() {
  setupTheme();
  setupResizers();
}
