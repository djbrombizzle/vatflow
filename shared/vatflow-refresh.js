/**
 * Shared helpers: defer live rebuilds while typing and restore focus after re-render.
 */

/** Default VATSIM poll intervals (ms). */
export const VATSIM_FEED_MS = 30000;
export const VATSIM_FEED_TAXI_MS = 20000;
export const UI_DRIFT_MS = 30000;
export const LIVE_PAGE_REFRESH_SEC = 30;

export function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "select") return true;
  if (tag === "input") {
    const type = (el.type || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset", "file", "hidden", "range", "color"].includes(type);
  }
  return !!el.isContentEditable;
}

export function isUserTyping() {
  return isTypingTarget(document.activeElement);
}

function escAttr(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Snapshot the focused form field before replacing innerHTML.
 * @param {ParentNode} [root]
 */
export function captureFocus(root = document) {
  const act = document.activeElement;
  if (!act || !isTypingTarget(act)) return null;
  if (root !== document && root.contains && !root.contains(act)) return null;
  const snap = {
    s: act.selectionStart,
    e: act.selectionEnd,
    value: act.value,
  };
  if (act.id) {
    snap.id = act.id;
    return snap;
  }
  const ds = act.dataset || {};
  if (ds.keep) { snap.keep = ds.keep; return snap; }
  if (ds.filter) { snap.filter = ds.filter; return snap; }
  if (ds.restrfield) { snap.restrfield = ds.restrfield; return snap; }
  if (ds.ratecalcField) { snap.ratecalcField = ds.ratecalcField; return snap; }
  if (ds.readyCs) { snap.readyCs = ds.readyCs; return snap; }
  if (ds.rdyTimeCs) { snap.rdyTimeCs = ds.rdyTimeCs; snap.rdyFca = ds.rdyFca; return snap; }
  if (ds.rdyTime) { snap.rdyTimeCs = ds.rdyTime; return snap; }
  if (act.classList?.contains("rdy-time-input")) {
    snap.rdyTimeInput = true;
    snap.rdyTimeCs = ds.rdyTimeCs;
    snap.rdyFca = ds.rdyFca;
    return snap;
  }
  if (act.classList?.contains("ready-input")) {
    snap.readyInput = true;
    snap.readyCs = ds.readyCs;
    return snap;
  }
  return snap;
}

/**
 * Restore focus after a rebuild.
 * @param {ParentNode} root
 * @param {object|null} snap
 */
export function restoreFocus(root, snap) {
  if (!snap || !root) return;
  const q = sel => (root.querySelector ? root.querySelector(sel) : document.querySelector(sel));
  let el = null;
  if (snap.id) {
    el = (root.getElementById && root.getElementById(snap.id)) || document.getElementById(snap.id);
  } else if (snap.keep) {
    el = q(`[data-keep="${escAttr(snap.keep)}"]`);
  } else if (snap.filter) {
    el = q(`input[data-filter="${escAttr(snap.filter)}"]`);
  } else if (snap.restrfield) {
    el = q(`[data-restrfield="${escAttr(snap.restrfield)}"]`);
  } else if (snap.ratecalcField) {
    el = q(`[data-ratecalc-field="${escAttr(snap.ratecalcField)}"]`);
  } else if (snap.rdyTimeCs) {
    el = q(`[data-rdy-time-cs="${escAttr(snap.rdyTimeCs)}"]`)
      || q(`[data-rdy-time="${escAttr(snap.rdyTimeCs)}"]`);
  } else if (snap.readyCs) {
    el = q(`.ready-input[data-ready-cs="${escAttr(snap.readyCs)}"]`);
  }
  if (!el) return;
  if (snap.value != null && "value" in el) el.value = snap.value;
  el.focus();
  try {
    if (snap.s != null && snap.e != null) el.setSelectionRange(snap.s, snap.e);
  } catch (_) {}
}

let pendingFlush = null;

/**
 * If the user is typing, queue flushFn for after focus leaves the field.
 * @param {() => void} flushFn
 * @returns {boolean} true when deferred (caller should skip the render)
 */
export function deferWhileTyping(flushFn) {
  if (!isUserTyping()) {
    pendingFlush = null;
    return false;
  }
  pendingFlush = flushFn;
  return true;
}

function installFocusoutFlush() {
  if (installFocusoutFlush.done) return;
  installFocusoutFlush.done = true;
  document.addEventListener("focusout", () => {
    setTimeout(() => {
      if (pendingFlush && !isUserTyping()) {
        const fn = pendingFlush;
        pendingFlush = null;
        fn();
      }
    }, 80);
  });
}
installFocusoutFlush();
