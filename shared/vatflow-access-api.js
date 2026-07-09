const DEFAULT_BASE = "https://vatflow-hub-production.up.railway.app";

function normalizeBase(url) {
  const raw = (url || DEFAULT_BASE).trim();
  return raw.replace(/\/+$/, "");
}

export function getAccessApiBase() {
  try {
    const custom = localStorage.getItem("vatflow.accessApiBase");
    if (custom) return normalizeBase(custom);
  } catch (_) {}
  return normalizeBase(DEFAULT_BASE);
}

export async function verifyPagePassword(page, password) {
  const res = await fetch(`${getAccessApiBase()}/access/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page, password }),
  });
  if (!res.ok) return { ok: false };
  return res.json();
}

export async function adminLogin(password) {
  const res = await fetch(`${getAccessApiBase()}/access/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) return { ok: false };
  return res.json();
}

export async function getAdminConfig(token) {
  const res = await fetch(`${getAccessApiBase()}/access/admin/config`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

export async function setPagePassword(token, page, password) {
  const res = await fetch(`${getAccessApiBase()}/access/admin/password`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ page, password }),
  });
  if (!res.ok) return { ok: false };
  return res.json();
}
