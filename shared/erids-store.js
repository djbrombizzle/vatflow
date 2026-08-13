/**
 * ERIDS config store — load/save ARTCC packs via vatflow-hub.
 */
import { getAccessApiBase } from "./vatflow-access-api.js";
import { getStoredToken } from "./vatflow-auth.js";

function hubBase() {
  return getAccessApiBase().replace(/\/+$/, "");
}

/**
 * @param {string} artcc
 * @returns {Promise<{ok:boolean, artcc:string, config:object|null, updatedAt:string|null, source:string}>}
 */
export async function fetchHubEridsConfig(artcc) {
  const id = String(artcc || "").toUpperCase();
  const res = await fetch(`${hubBase()}/erids/config?artcc=${encodeURIComponent(id)}`, {
    method: "GET",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/**
 * @param {string} artcc
 * @param {object} config
 */
export async function saveHubEridsConfig(artcc, config) {
  const token = getStoredToken();
  if (!token) throw new Error("Sign in required");
  const res = await fetch(`${hubBase()}/erids/config`, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ artcc: String(artcc || "").toUpperCase(), config }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Save failed (" + res.status + ")");
  }
  return data;
}

/**
 * @param {string} artcc
 */
export async function deleteHubEridsConfig(artcc) {
  const token = getStoredToken();
  if (!token) throw new Error("Sign in required");
  const id = String(artcc || "").toUpperCase();
  const res = await fetch(`${hubBase()}/erids/config?artcc=${encodeURIComponent(id)}`, {
    method: "DELETE",
    mode: "cors",
    credentials: "omit",
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Delete failed (" + res.status + ")");
  }
  return data;
}

/** ChartFox airport page — plates/SIDs/STARs live here. */
export function chartfoxUrl(icao) {
  const id = String(icao || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!id) return "https://chartfox.org/";
  const full = id.length === 3 ? "K" + id : id;
  return "https://chartfox.org/" + full;
}

export function isChartfoxUrl(url) {
  try {
    const u = new URL(url, "https://chartfox.org");
    return /(^|\.)chartfox\.org$/i.test(u.hostname);
  } catch {
    return /chartfox\.org/i.test(String(url || ""));
  }
}

/** Prefer ChartFox for procedure/chart-style links. */
export function shouldOpenInChartViewer(url, context = {}) {
  if (isChartfoxUrl(url)) return true;
  const section = String(context.section || "").toLowerCase();
  return ["approaches", "sids", "stars", "runways", "charts", "chart"].includes(section);
}
