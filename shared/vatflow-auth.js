/**
 * VATFLOW — VATSIM Connect session (browser).
 */
import { getAccessApiBase } from "./vatflow-access-api.js";

const LS_TOKEN = "vatflow.sessionToken.v1";
const LS_RETURN = "vatflow.authReturnPath.v1";

let _session = null;
let _ready = false;

function decodeJwtPayload(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

function isExpired(claims) {
  return !claims || !claims.exp || Date.now() / 1000 >= claims.exp;
}

function claimsToSession(claims) {
  if (!claims || !claims.cid) return null;
  return {
    cid: String(claims.cid),
    name: claims.name || claims.cid,
    rating: Number(claims.rating || 0),
    ratingShort: claims.ratingShort || "",
    division: claims.division || "",
    subdivision: claims.subdivision || "",
    tier: claims.tier || (claims.fullAccess ? "full" : "basic"),
    fullAccess: !!claims.fullAccess || claims.tier === "full",
    fullAccessReason: claims.fullAccessReason || null,
    isAdmin: !!claims.isAdmin,
    exp: claims.exp,
  };
}

export function getStoredToken() {
  try { return localStorage.getItem(LS_TOKEN) || ""; } catch { return ""; }
}

export function setStoredToken(token) {
  try {
    if (token) localStorage.setItem(LS_TOKEN, token);
    else localStorage.removeItem(LS_TOKEN);
  } catch (_) {}
}

export function getSession() {
  return _session;
}

export function isSignedIn() {
  return !!(_session && _session.cid);
}

export function canFullControl() {
  return isSignedIn() && !!_session.fullAccess;
}

export function canUseRunwayBalancer() {
  return isSignedIn();
}

export function canUseFcaRdy() {
  return isSignedIn();
}

export function canUseTowerFull() {
  return canFullControl();
}

export function isAdmin() {
  return isSignedIn() && !!_session.isAdmin;
}

export function authStatusLabel() {
  if (!isSignedIn()) return "View only";
  if (canFullControl()) return "Controller";
  return "Signed in";
}

function emitAuthChange() {
  window.dispatchEvent(new CustomEvent("vatflow-auth-changed", { detail: { session: _session } }));
}

function applyClaims(claims) {
  _session = claimsToSession(claims);
  emitAuthChange();
  return _session;
}

export async function refreshSession() {
  const token = getStoredToken();
  if (!token) {
    _session = null;
    emitAuthChange();
    return null;
  }
  const local = decodeJwtPayload(token);
  if (isExpired(local)) {
    setStoredToken("");
    _session = null;
    emitAuthChange();
    return null;
  }
  applyClaims(local);
  try {
    const res = await fetch(`${getAccessApiBase()}/auth/session`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      setStoredToken("");
      _session = null;
      emitAuthChange();
      return null;
    }
    const data = await res.json();
    if (!data.ok) {
      setStoredToken("");
      _session = null;
      emitAuthChange();
      return null;
    }
    _session = {
      cid: String(data.cid),
      name: data.name || data.cid,
      rating: Number(data.rating || 0),
      ratingShort: data.ratingShort || "",
      division: data.division || "",
      subdivision: data.subdivision || "",
      tier: data.tier || "basic",
      fullAccess: !!data.fullAccess,
      fullAccessReason: data.fullAccessReason || null,
      isAdmin: !!data.isAdmin,
      exp: data.exp,
    };
    emitAuthChange();
    return _session;
  } catch {
    return _session;
  }
}

export function login(returnPath) {
  const path = returnPath || `${window.location.pathname}${window.location.search}`;
  try { sessionStorage.setItem(LS_RETURN, path); } catch (_) {}
  const returnTo = `${window.location.origin}/auth-callback.html`;
  window.location.href = `${getAccessApiBase()}/auth/vatsim/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function logout() {
  const token = getStoredToken();
  if (token) {
    try {
      await fetch(`${getAccessApiBase()}/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    } catch (_) {}
  }
  setStoredToken("");
  _session = null;
  emitAuthChange();
}

export function acceptTokenFromCallback(token) {
  setStoredToken(token);
  return applyClaims(decodeJwtPayload(token));
}

export function consumeReturnPath() {
  try {
    const p = sessionStorage.getItem(LS_RETURN) || "index.html";
    sessionStorage.removeItem(LS_RETURN);
    return p;
  } catch {
    return "index.html";
  }
}

export function clearLocalVatflowData() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (k.startsWith("vatflow.") || k.startsWith("towerDep.") || k.startsWith("artccDashboard.") || k.startsWith("fcaBuilder.") ||
        k.startsWith("runwayBalancer.") || k === "vatflow_pilot_cid") keys.push(k);
  }
  keys.forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
  try { sessionStorage.clear(); } catch (_) {}
}

export async function requestGdprDelete() {
  const token = getStoredToken();
  if (!token) return { ok: false };
  const res = await fetch(`${getAccessApiBase()}/auth/gdpr-delete`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const data = res.ok ? await res.json() : { ok: false };
  clearLocalVatflowData();
  setStoredToken("");
  _session = null;
  emitAuthChange();
  return data;
}

export async function initVatflowAuth() {
  if (!_ready) {
    _ready = true;
    await refreshSession();
  }
  return _session;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

export function mountAuthNav(container) {
  if (!container) return;

  let wrap = container.querySelector(".vf-auth");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "vf-auth";
    wrap.id = "vfAuthNav";
    container.appendChild(wrap);
  }

  function render() {
    const el = container.querySelector("#vfAuthNav");
    if (!el) return;
    const adminLink = container.querySelector('a[href="admin-access.html"]');
    if (adminLink) adminLink.style.display = isAdmin() ? "" : "none";

    if (!isSignedIn()) {
      el.innerHTML = `<button type="button" class="vf-auth-btn" id="vfSignInBtn">Sign in with VATSIM</button>`;
      el.querySelector("#vfSignInBtn")?.addEventListener("click", () => login());
      return;
    }
    const s = _session;
    const label = s.ratingShort ? `${s.cid} · ${s.ratingShort}` : s.cid;
    el.innerHTML =
      `<span class="vf-auth-user" title="${escapeAttr(s.name)}">${escapeHtml(label)}</span>` +
      `<span class="vf-auth-tier">${escapeHtml(authStatusLabel())}</span>` +
      `<button type="button" class="vf-auth-link" id="vfSignOutBtn">Sign out</button>` +
      `<button type="button" class="vf-auth-link vf-auth-danger" id="vfGdprBtn">Delete my data</button>`;
    el.querySelector("#vfSignOutBtn")?.addEventListener("click", () => logout().then(render));
    el.querySelector("#vfGdprBtn")?.addEventListener("click", async () => {
      if (!confirm("Delete your VATFLOW sign-in records and clear all local settings on this browser? Shared FCA data created during events is not removed.")) return;
      await requestGdprDelete();
      render();
    });
  }

  window.addEventListener("vatflow-auth-changed", render);
  render();
}

if (typeof window !== "undefined") {
  window.VatflowAuth = {
    getSession, isSignedIn, canFullControl, canUseRunwayBalancer, canUseFcaRdy,
    canUseTowerFull, isAdmin, authStatusLabel, login, logout, refreshSession,
    initVatflowAuth, requestGdprDelete, getStoredToken,
  };
}
