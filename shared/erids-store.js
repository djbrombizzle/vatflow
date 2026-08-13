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
    if (res.status === 404) {
      throw new Error(
        "Hub ERIDS API not deployed yet (404). Merge & deploy vatflow-hub PR #7, then retry Save."
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(data.error || "Not allowed to edit this ARTCC — need editor/staff access.");
    }
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

export function looksLikePdfUrl(url) {
  const s = String(url || "").toLowerCase();
  if (!s) return false;
  if (/\.pdf($|\?|#)/i.test(s)) return true;
  if (/\/pdf\//i.test(s)) return true;
  if (/format=pdf|type=pdf|download=pdf/i.test(s)) return true;
  return false;
}

/** Open in ERIDS overlay: charts, SOPs/docs, or explicit PDF links. */
export function shouldOpenInViewer(url, context = {}) {
  if (isChartfoxUrl(url) || looksLikePdfUrl(url)) return true;
  const section = String(context.section || "").toLowerCase();
  return [
    "approaches",
    "sids",
    "stars",
    "runways",
    "charts",
    "chart",
    "docs",
    "sops",
    "sop",
    "home",
  ].includes(section);
}

/** @deprecated use shouldOpenInViewer */
export function shouldOpenInChartViewer(url, context = {}) {
  return shouldOpenInViewer(url, context);
}

/**
 * Fetch a document through the hub proxy (signed-in). Returns blob + contentType.
 * @param {string} docUrl
 * @returns {Promise<{blob:Blob, contentType:string, finalUrl:string|null}>}
 */
export async function fetchProxiedDocument(docUrl) {
  const token = getStoredToken();
  if (!token) throw new Error("Sign in required to embed documents");
  const res = await fetch(
    `${hubBase()}/erids/proxy?url=${encodeURIComponent(docUrl)}`,
    {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      headers: { authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    let err = "proxy_http_" + res.status;
    try {
      const j = await res.clone().json();
      if (j && j.error) err = j.error;
    } catch (_) {}
    throw new Error(err);
  }
  const contentType = String(res.headers.get("content-type") || "application/octet-stream")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const buf = await res.arrayBuffer();
  return {
    blob: new Blob([buf], { type: contentType || "application/octet-stream" }),
    contentType,
    finalUrl: res.headers.get("x-erids-final-url"),
  };
}

export function isPdfContentType(ctype) {
  const c = String(ctype || "").toLowerCase();
  return c === "application/pdf" || c === "application/x-pdf" || c.includes("pdf");
}
