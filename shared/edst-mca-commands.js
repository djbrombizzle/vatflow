/**
 * EDST Message Composition Area — ERAM-style /U uplink command parser.
 * FLID / ACID = aircraft callsign. Commands mirror CRC ERAM (virtualnas docs).
 *
 * Supported (require /U to send CPDLC):
 *   QZ <alt> <FLID> /U          assigned altitude
 *   QQ <alt> <FLID> /U          interim altitude (same CPDLC as assigned)
 *   QU <fix>… <FLID> /U         proceed direct (first fix)
 *   QS <hdg> <FLID> /U          fly heading
 *   QS /<spd> <FLID> /U         maintain speed (knots)
 *
 * Optional modifiers (any order): /PD /IMM /EXP /TFC /RES /WX /OK
 */
const REASON_TEXT = {
  IMM: "IMMEDIATELY",
  EXP: "EXPEDITE",
  TFC: "DUE TO TRAFFIC",
  RES: "DUE TO RESTRICTED AIRSPACE",
  WX: "DUE TO WEATHER",
};
const MOD_KEYS = new Set(["PD", "IMM", "EXP", "TFC", "RES", "WX", "OK", "U"]);

function reasonSuffix(mods) {
  const order = ["IMM", "EXP", "TFC", "RES", "WX"];
  const parts = [];
  for (const k of order) {
    if (mods.has(k) && REASON_TEXT[k]) parts.push(REASON_TEXT[k]);
  }
  return parts.length ? ", " + parts.join(", ") : "";
}

function parseAltitudeToken(tok) {
  const s = String(tok || "").toUpperCase().replace(/,/g, "");
  if (!s) return null;
  if (/^VFR(\/\d{2,3})?$/.test(s) || s === "OTP" || /^OTP\/\d{2,3}$/.test(s)) {
    return { kind: "vfr", raw: s };
  }
  const block = s.match(/^(\d{2,3})B(\d{2,3})$/);
  if (block) return { kind: "block", lo: +block[1], hi: +block[2], fl: +block[1] };
  if (s.startsWith("FL")) {
    const fl = parseInt(s.slice(2), 10);
    return fl ? { kind: "fl", fl } : null;
  }
  if (/^\d{2,3}$/.test(s)) return { kind: "fl", fl: +s };
  if (/^\d{4,5}$/.test(s)) return { kind: "fl", fl: Math.round(+s / 100) };
  return null;
}

function isCallsignToken(tok) {
  const t = String(tok || "").toUpperCase();
  if (!t || t.startsWith("/")) return false;
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(t)) return false;
  // VATSIM ACIDs include a digit; pure-alpha tokens are usually fixes/airports.
  if (!/\d/.test(t)) return false;
  // QQ interim / local / procedure altitude prefixes (R110, L150, P090)
  if (/^[RLP]\d{2,3}$/.test(t)) return false;
  if (parseAltitudeToken(t)) return false;
  return true;
}

function isFixToken(tok) {
  const t = String(tok || "").toUpperCase();
  if (!t || t.startsWith("/")) return false;
  if (isCallsignToken(t) && t.length > 5) return false;
  return /^[A-Z][A-Z0-9]{1,5}$/.test(t) && !parseAltitudeToken(t);
}

/**
 * @param {string} raw
 * @param {{ selectedCs?: string|null }} [opts]
 * @returns {{ ok: true, verb: string, flid: string, uplink: boolean, mods: Set<string>, payload: object }
 *          |{ ok: false, error: string }}
 */
export function parseMcaCommand(raw, opts = {}) {
  let text = String(raw || "").toUpperCase().replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, error: "NULL CMD" };

  const mods = new Set();
  // Tokenize; slash-mods may be glued (/U, /PD) or spaced
  const rough = text.split(" ").filter(Boolean);
  const tokens = [];
  for (const t of rough) {
    if (t.startsWith("/") && t.length > 1) {
      // /U or /PD/IMM style — split consecutive mods rarely; usually one
      const body = t.slice(1);
      if (body.includes("/")) {
        body.split("/").filter(Boolean).forEach(m => mods.add(m));
      } else if (/^\d+$/.test(body)) {
        // QS /280 speed form kept as token
        tokens.push(t);
      } else {
        mods.add(body);
      }
    } else {
      tokens.push(t);
    }
  }

  if (!tokens.length) return { ok: false, error: "NULL CMD" };

  const verb = tokens[0];
  const rest = tokens.slice(1);
  const uplink = mods.has("U");

  // Collect FLID candidates from end / multi-FLID with /
  let flid = "";
  const body = [];
  for (const t of rest) {
    if (t.includes("/") && !t.startsWith("/")) {
      // AAL123/UAL456 multi — take first for uplink
      const parts = t.split("/").filter(Boolean);
      if (parts.every(isCallsignToken)) {
        flid = parts[0];
        continue;
      }
    }
    if (isCallsignToken(t)) {
      flid = t;
      continue;
    }
    body.push(t);
  }
  if (!flid && opts.selectedCs) flid = String(opts.selectedCs).toUpperCase();
  if (!flid) return { ok: false, error: "NO FLID" };

  if (!uplink) {
    return { ok: false, error: "REQUIRE /U", flid, verb };
  }

  if (verb === "QZ" || verb === "QQ") {
    // QQ R150 / QQ L150 / QQ P150 — strip interim prefix letter
    let altTok = body[0] || "";
    if (/^[RLP]\d{2,3}$/.test(altTok)) altTok = altTok.slice(1);
    const alt = parseAltitudeToken(altTok);
    if (!alt || alt.kind === "vfr") {
      return { ok: false, error: "ILL ALT", flid, verb };
    }
    const fl = alt.fl;
    if (!fl || fl < 10 || fl > 600) return { ok: false, error: "ILL ALT", flid, verb };
    return {
      ok: true,
      verb,
      flid,
      uplink: true,
      mods,
      payload: { type: "alt", fl, pd: mods.has("PD") },
    };
  }

  if (verb === "QU") {
    const fixes = body.filter(isFixToken);
    if (!fixes.length) return { ok: false, error: "NO FIX", flid, verb };
    return {
      ok: true,
      verb,
      flid,
      uplink: true,
      mods,
      payload: { type: "direct", fix: fixes[0], pd: mods.has("PD") },
    };
  }

  if (verb === "QS") {
    // Speed: QS /280 … or QS S280
    const spdTok = body.find(t => /^\/\d{2,3}$/.test(t) || /^S\d{2,3}$/.test(t));
    if (spdTok) {
      const kt = parseInt(spdTok.replace(/\D/g, ""), 10);
      if (!kt || kt < 80 || kt > 400) return { ok: false, error: "ILL SPD", flid, verb };
      return {
        ok: true,
        verb,
        flid,
        uplink: true,
        mods,
        payload: { type: "spd", kt },
      };
    }
    // Heading: QS 090, QS H090, QS LT 090, QS RT 090, QS PH
    if (body.some(t => t === "PH" || t === "PHDG")) {
      return {
        ok: true,
        verb,
        flid,
        uplink: true,
        mods,
        payload: { type: "hdg", mode: "PH" },
      };
    }
    let mode = "NP";
    let hdgTok = null;
    for (const t of body) {
      if (t === "LT" || t === "L") mode = "LT";
      else if (t === "RT" || t === "RH" || t === "R") mode = "RH";
      else if (/^H?\d{1,3}$/.test(t)) hdgTok = t.replace(/^H/, "");
    }
    if (!hdgTok) return { ok: false, error: "ILL HDG", flid, verb };
    let hdg = parseInt(hdgTok, 10);
    if (!Number.isFinite(hdg) || hdg < 1 || hdg > 360) return { ok: false, error: "ILL HDG", flid, verb };
    if (hdg === 0) hdg = 360;
    return {
      ok: true,
      verb,
      flid,
      uplink: true,
      mods,
      payload: { type: "hdg", mode, hdg },
    };
  }

  return { ok: false, error: "ILL CMD", flid, verb };
}

/**
 * Build a sendUplinkEntry-compatible {label,msg,effects} from a parsed command.
 * @param {object} parsed — success result from parseMcaCommand
 * @param {{ alt?: number|null }} [ac] — aircraft for climb/descend verb
 */
export function buildMcaUplinkEntry(parsed, ac = {}) {
  if (!parsed || !parsed.ok) return null;
  const mods = parsed.mods || new Set();
  const suf = reasonSuffix(mods);
  const pd = mods.has("PD") || !!(parsed.payload && parsed.payload.pd);
  const p = parsed.payload;

  if (p.type === "alt") {
    const fl = p.fl;
    const cur = ac.alt != null ? +ac.alt : fl;
    let msg;
    if (fl < 180) {
      const verb = fl > cur ? "CLIMB AND MAINTAIN" : fl < cur ? "DESCEND AND MAINTAIN" : "MAINTAIN";
      const feet = (fl * 100).toLocaleString("en-US") + "ft";
      msg = `${verb} ${feet}`;
    } else {
      const verb = fl > cur ? "CLIMB TO AND MAINTAIN" : fl < cur ? "DESCEND TO AND MAINTAIN" : "MAINTAIN";
      const pad = ("000" + fl).slice(-3);
      msg = `${verb} @FL${pad}@`;
    }
    if (pd) msg += " AT PILOTS DISCRETION";
    msg += suf;
    return { label: "ALT", msg, effects: { type: "alt", alt: fl } };
  }

  if (p.type === "direct") {
    let msg = `PROCEED DIRECT TO @${p.fix}@`;
    if (pd) msg += " AT PILOTS DISCRETION";
    msg += suf;
    return { label: "DIRECT", msg, effects: { type: "route" } };
  }

  if (p.type === "hdg") {
    if (p.mode === "PH") {
      return { label: "HDG", msg: "FLY PRESENT HEADING" + suf, effects: { type: "hdg", hdg: "PH" } };
    }
    const pad = ("000" + p.hdg).slice(-3);
    let verb = "FLY HEADING";
    if (p.mode === "LT") verb = "TURN LEFT HEADING";
    if (p.mode === "RH") verb = "TURN RIGHT HEADING";
    return {
      label: "HDG",
      msg: `${verb} @${pad}@` + suf,
      effects: { type: "hdg", hdg: p.hdg },
    };
  }

  if (p.type === "spd") {
    return {
      label: "SPD",
      msg: `MAINTAIN @${p.kt}KT@` + suf,
      effects: { type: "spd", spd: p.kt },
    };
  }

  return null;
}

export function formatMcaAccept(parsed, entry) {
  const lines = ["ACCEPT", parsed.verb + (entry && entry.label ? " " + entry.label : ""), parsed.flid];
  return lines;
}

export function formatMcaReject(error, detail) {
  return ["REJECT", error || "ILL CMD", detail || ""].filter(Boolean);
}
