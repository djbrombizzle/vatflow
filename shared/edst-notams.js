/**
 * EDST NOTAMS — ARTCC TFR feed + on-demand airport lookup via hub.
 *
 * Hub endpoints (POST JSON):
 *   /hub/notams { artcc: "KZJX" }
 *   /hub/notams { icao: "KGSP" }
 */
(function (global) {
  "use strict";

  var DEFAULT_HUB = "https://web-production-3d9fe.up.railway.app";
  var HUB_TIMEOUT_MS = 8000;

  var FILTERS = [
    { id: "all", label: "ALL" },
    { id: "tfr", label: "TFR & AIRSPACE" },
    { id: "navaid", label: "NAVAID" },
    { id: "airport", label: "AIRPORT" },
  ];

  var SORTS = [
    { id: "effective", label: "EFFECTIVE" },
    { id: "expiration", label: "EXPIRATION" },
    { id: "location", label: "LOCATION" },
    { id: "id", label: "ID" },
  ];

  function hubBase() {
    try {
      if (global.settings && global.settings.hubUrl)
        return String(global.settings.hubUrl).replace(/\/+$/, "");
    } catch (_) {}
    return DEFAULT_HUB;
  }

  function normalizeIcao(icao) {
    icao = String(icao || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (icao.length === 3 && /^[A-Z]{3}$/.test(icao)) {
      if (icao[0] === "Y") return "C" + icao;
      return "K" + icao;
    }
    return icao;
  }

  function bareArtcc(id) {
    return String(id || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .replace(/^K(?=Z)/, "");
  }

  function parseTime(value) {
    if (value == null || value === "") return null;
    if (typeof value === "number" && isFinite(value)) {
      var ms = value < 1e12 ? value * 1000 : value;
      var d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }
    var parsed = new Date(String(value));
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  function isExpired(entry, now) {
    if (!entry) return true;
    if (entry.expired) return true;
    var end = parseTime(entry.end);
    if (end && now > end) return true;
    return false;
  }

  function fetchJson(url, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : HUB_TIMEOUT_MS;
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = null;
    if (ctrl && timeoutMs > 0) {
      timer = setTimeout(function () {
        try {
          ctrl.abort();
        } catch (_) {}
      }, timeoutMs);
    }
    return fetch(url, {
      method: opts.method || "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      signal: ctrl ? ctrl.signal : undefined,
      headers: Object.assign(
        { Accept: "application/json" },
        opts.headers || {}
      ),
      body: opts.body,
    })
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (_) {
            throw new Error("hub returned non-JSON");
          }
          if (!res.ok) {
            throw new Error((data && data.error) || "HTTP " + res.status);
          }
          return data;
        });
      })
      .finally(function () {
        if (timer) clearTimeout(timer);
      });
  }

  function hubNotams(payload) {
    return fetchJson(hubBase() + "/hub/notams", {
      method: "POST",
      timeoutMs: HUB_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    }).then(function (data) {
      if (!data || data.ok === false)
        throw new Error((data && data.error) || "hub notams failed");
      return data;
    });
  }

  function fetchNotamsForArtcc(artcc, opts) {
    opts = opts || {};
    var art = bareArtcc(artcc);
    if (!art) {
      return Promise.resolve({
        artcc: "",
        entries: [],
        error: "Set or verify an ARTCC to load NOTAMs.",
        warning: null,
      });
    }
    return hubNotams({ artcc: art, force: !!opts.force })
      .then(function (data) {
        var entries = Array.isArray(data.entries) ? data.entries : [];
        return {
          artcc: bareArtcc(data.artcc || art),
          entries: entries,
          error: null,
          warning: data.warning || null,
          faaConfigured: !!data.faaConfigured,
        };
      })
      .catch(function (err) {
        return {
          artcc: art,
          entries: [],
          error: (err && err.message) || "Failed to fetch NOTAMs",
          warning: null,
        };
      });
  }

  function fetchNotamsForIcao(icao, opts) {
    opts = opts || {};
    var id = normalizeIcao(icao);
    if (!/^[A-Z]{4}$/.test(id)) {
      return Promise.reject(new Error("Invalid airport ICAO"));
    }
    return hubNotams({ icao: id, force: !!opts.force }).then(function (data) {
      return {
        icao: normalizeIcao(data.icao || id),
        entries: Array.isArray(data.entries) ? data.entries : [],
        warning: data.warning || null,
        faaConfigured: !!data.faaConfigured,
      };
    });
  }

  function matchesFilter(entry, filterId) {
    var cat = String((entry && entry.category) || "").toLowerCase();
    var fid = String(filterId || "all").toLowerCase();
    if (fid === "all" || !fid) return true;
    if (fid === "tfr") return cat === "tfr" || cat === "airspace";
    return cat === fid;
  }

  function filterEntries(entries, filterId, now) {
    now = now || new Date();
    return (entries || []).filter(function (e) {
      if (isExpired(e, now)) return false;
      return matchesFilter(e, filterId);
    });
  }

  function sortEntries(entries, sortId) {
    var list = (entries || []).slice();
    var sid = String(sortId || "effective").toLowerCase();
    list.sort(function (a, b) {
      if (sid === "expiration") {
        var ae = parseTime(a.end);
        var be = parseTime(b.end);
        var at = ae ? ae.getTime() : Number.MAX_SAFE_INTEGER;
        var bt = be ? be.getTime() : Number.MAX_SAFE_INTEGER;
        if (at !== bt) return at - bt;
      } else if (sid === "location") {
        var al = String(a.location || "").toUpperCase();
        var bl = String(b.location || "").toUpperCase();
        if (al !== bl) return al < bl ? -1 : 1;
      } else if (sid === "id") {
        var ai = String(a.id || a.notamId || "").toUpperCase();
        var bi = String(b.id || b.notamId || "").toUpperCase();
        if (ai !== bi) return ai < bi ? -1 : 1;
      } else {
        // effective (default)
        var as = parseTime(a.start) || parseTime(a.issueTime);
        var bs = parseTime(b.start) || parseTime(b.issueTime);
        var ast = as ? as.getTime() : 0;
        var bst = bs ? bs.getTime() : 0;
        if (ast !== bst) return ast - bst;
      }
      return String(a.id || "").localeCompare(String(b.id || ""));
    });
    return list;
  }

  /** True if input looks like a NOTAM number rather than an ICAO. */
  function looksLikeNotamId(raw) {
    var s = String(raw || "").trim().toUpperCase();
    if (!s) return false;
    if (/^[A-Z]{3,4}$/.test(s.replace(/[^A-Z]/g, "")) && s.length <= 4 && !/\d/.test(s))
      return false;
    if (/^\d{1,2}\/\d{2,5}$/.test(s)) return true;
    if (/^(FDC|TFR|!TFR)\s*\d/i.test(s)) return true;
    if (/!\s*[A-Z0-9]/.test(s)) return true;
    if (/\d/.test(s) && /[\/\-]/.test(s)) return true;
    return false;
  }

  function normalizeNotamQuery(raw) {
    return String(raw || "")
      .trim()
      .toUpperCase()
      .replace(/^!TFR\s*/i, "")
      .replace(/^TFR\s+/i, "")
      .replace(/^FDC\s+/i, "")
      .replace(/^!/, "")
      .replace(/\s+/g, " ");
  }

  function findNotamIds(entries, query) {
    var q = normalizeNotamQuery(query);
    if (!q) return [];
    var hits = [];
    (entries || []).forEach(function (e, idx) {
      var blob = [
        e.id,
        e.notamId,
        e.location,
        e.text,
        e.fullText,
      ]
        .map(function (x) {
          return String(x || "").toUpperCase();
        })
        .join(" ");
      if (blob.indexOf(q) >= 0) hits.push(String(e.id || ("not-" + idx)));
    });
    return hits;
  }

  function filterLabel(id) {
    for (var i = 0; i < FILTERS.length; i++) {
      if (FILTERS[i].id === id) return FILTERS[i].label;
    }
    return "ALL";
  }

  function sortLabel(id) {
    for (var i = 0; i < SORTS.length; i++) {
      if (SORTS[i].id === id) return SORTS[i].label;
    }
    return "EFFECTIVE";
  }

  global.EdstNotams = {
    FILTERS: FILTERS,
    SORTS: SORTS,
    hubBase: hubBase,
    normalizeIcao: normalizeIcao,
    bareArtcc: bareArtcc,
    fetchNotamsForArtcc: fetchNotamsForArtcc,
    fetchNotamsForIcao: fetchNotamsForIcao,
    filterEntries: filterEntries,
    sortEntries: sortEntries,
    matchesFilter: matchesFilter,
    looksLikeNotamId: looksLikeNotamId,
    findNotamIds: findNotamIds,
    filterLabel: filterLabel,
    sortLabel: sortLabel,
    isExpired: isExpired,
    parseTime: parseTime,
  };
})(typeof window !== "undefined" ? window : globalThis);
