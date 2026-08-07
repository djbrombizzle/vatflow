/**
 * EDST SIG — SIGMETs for the controller's FIR/ARTCC.
 *
 * NWS Aviation API provides FIR-scoped advisories (CORS-friendly).
 * Raw bulletin text is enriched from AWC airsigmet / isigmet when available
 * (AWC blocks browser CORS, so public proxies are used — same pattern as winds-aloft).
 */
(function (global) {
  "use strict";

  var NWS_SIGMETS = "https://api.weather.gov/aviation/sigmets";
  var AWC_AIRSIGMET = "https://aviationweather.gov/api/data/airsigmet?format=json";
  var AWC_ISIGMET = "https://aviationweather.gov/api/data/isigmet?format=json";
  var CORS_PROXIES = [
    function (u) {
      return "https://api.allorigins.win/raw?url=" + encodeURIComponent(u);
    },
    function (u) {
      return "https://corsproxy.io/?url=" + encodeURIComponent(u);
    },
  ];

  function normalizeArtcc(raw) {
    var id = String(raw || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!id) return "";
    if (/^K[A-Z]{3}$/.test(id)) return id;
    if (/^[A-Z]{3}$/.test(id)) return "K" + id;
    return id;
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

  function entryStart(entry) {
    return entry.validTimeFrom != null ? entry.validTimeFrom : entry.start;
  }
  function entryEnd(entry) {
    return entry.validTimeTo != null ? entry.validTimeTo : entry.end;
  }

  function isCurrentlyValid(entry, now) {
    var start = parseTime(entryStart(entry));
    var end = parseTime(entryEnd(entry));
    if (start && now < start) return false;
    if (end && now > end) return false;
    return true;
  }

  function fetchJson(url, opts) {
    opts = opts || {};
    return fetch(url, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers: Object.assign(
        { Accept: "application/geo+json, application/json, text/plain, */*" },
        opts.headers || {}
      ),
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
      return res.json();
    });
  }

  /** Direct fetch, then CORS proxies (for AWC). */
  function fetchJsonFlexible(url) {
    return fetchJson(url).catch(function () {
      var chain = Promise.reject(new Error("direct failed"));
      CORS_PROXIES.forEach(function (prox) {
        chain = chain.catch(function () {
          return fetchJson(prox(url));
        });
      });
      return chain;
    });
  }

  function nwsStartIso(hoursBack) {
    var d = new Date(Date.now() - (hoursBack || 18) * 60 * 60 * 1000);
    return d.toISOString();
  }

  function indexAwcBySeries(list) {
    var bySeries = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(function (item) {
      if (!item || typeof item !== "object") return;
      var series = String(item.seriesId || item.series || "")
        .trim()
        .toUpperCase();
      var raw =
        item.rawAirSigmet ||
        item.rawSigmet ||
        item.rawOb ||
        item.raw ||
        "";
      item._rawText = String(raw || "").trim();
      if (series) bySeries[series] = item;
    });
    return { bySeries: bySeries, list: list || [] };
  }

  function fmtZulu(iso) {
    var d = parseTime(iso);
    if (!d) return String(iso || "?");
    var dd = String(d.getUTCDate()).padStart(2, "0");
    var hh = String(d.getUTCHours()).padStart(2, "0");
    var mm = String(d.getUTCMinutes()).padStart(2, "0");
    return dd + hh + mm + "Z";
  }

  function buildTextFromNws(props, awcHit) {
    if (awcHit && awcHit._rawText) return awcHit._rawText;
    var fir = props.fir || props.atsu || "";
    var seq = props.sequence || "";
    var hazard = props.hazard || props.phenomenon || "";
    var lines = [];
    lines.push(
      String(fir || "SIGMET") + (seq ? " SIGMET " + seq : " SIGMET")
    );
    if (hazard) lines.push("HAZARD: " + String(hazard).toUpperCase());
    if (props.issueTime) lines.push("ISSUED: " + fmtZulu(props.issueTime));
    var start = props.start || props.validTimeFrom;
    var end = props.end || props.validTimeTo;
    if (start || end) {
      lines.push("VALID " + fmtZulu(start) + "-" + fmtZulu(end));
    }
    return lines.join("\n");
  }

  function fromNwsFeature(feature, airIdx, isigIdx) {
    var props = (feature && feature.properties) || {};
    var seq = String(props.sequence || "")
      .trim()
      .toUpperCase();
    var awcHit =
      (seq && airIdx.bySeries[seq]) ||
      (seq && isigIdx.bySeries[seq]) ||
      null;
    var start = props.start || props.validTimeFrom || null;
    var end = props.end || props.validTimeTo || null;
    // Prefer AWC validity windows when NWS omits them
    if (awcHit) {
      if (start == null && awcHit.validTimeFrom != null)
        start = awcHit.validTimeFrom;
      if (end == null && awcHit.validTimeTo != null) end = awcHit.validTimeTo;
    }
    return {
      id: String(props.id || (feature && feature.id) || seq || Math.random()),
      fir: String(props.fir || props.atsu || "").toUpperCase(),
      sequence: seq,
      hazard: String(props.hazard || props.phenomenon || "").toLowerCase(),
      start: start,
      end: end,
      issueTime: props.issueTime || null,
      text: buildTextFromNws(props, awcHit),
      source: "nws",
    };
  }

  function fromIsigmet(item, artcc) {
    var fir = String(item.firId || "")
      .trim()
      .toUpperCase();
    if (fir !== artcc) return null;
    return {
      id: String(
        item.isigmetId || item.icaoId || item.seriesId || Math.random()
      ),
      fir: fir,
      sequence: String(item.seriesId || "").toUpperCase(),
      hazard: String(item.hazard || "").toLowerCase(),
      start: item.validTimeFrom || null,
      end: item.validTimeTo || null,
      issueTime: item.issueTime || null,
      text:
        String(item.rawSigmet || item.rawOb || "").trim() ||
        "(no text available)",
      source: "isigmet",
    };
  }

  /**
   * Fetch currently valid SIGMETs for an ARTCC/FIR (e.g. ZTL or KZTL).
   * @returns {Promise<{artcc:string, entries:Array, error:?string}>}
   */
  function fetchSigmetsForArtcc(artccRaw) {
    var artcc = normalizeArtcc(artccRaw);
    if (!artcc) {
      return Promise.resolve({
        artcc: "",
        entries: [],
        error: "No ARTCC/FIR available for this session.",
      });
    }

    var nwsUrl =
      NWS_SIGMETS + "?start=" + encodeURIComponent(nwsStartIso(18));

    return Promise.all([
      fetchJson(nwsUrl).catch(function () {
        return { features: [] };
      }),
      fetchJsonFlexible(AWC_AIRSIGMET).catch(function () {
        return [];
      }),
      fetchJsonFlexible(AWC_ISIGMET).catch(function () {
        return [];
      }),
    ]).then(function (results) {
      var nws = results[0] || {};
      var airIdx = indexAwcBySeries(results[1]);
      var isigIdx = indexAwcBySeries(results[2]);
      var now = new Date();
      var seen = Object.create(null);
      var entries = [];
      var nwsFeatures = Array.isArray(nws.features) ? nws.features : [];

      nwsFeatures.forEach(function (f) {
        var props = (f && f.properties) || {};
        var fir = String(props.fir || "")
          .trim()
          .toUpperCase();
        var atsu = String(props.atsu || "")
          .trim()
          .toUpperCase();
        // Scope to this controller's FIR only (not ATSU alone — KKCI covers many FIRs)
        if (fir !== artcc) return;
        var entry = fromNwsFeature(f, airIdx, isigIdx);
        if (!isCurrentlyValid(entry, now)) return;
        var key = (entry.sequence || "") + "|" + (entry.issueTime || entry.id);
        if (seen[key]) return;
        seen[key] = true;
        entries.push(entry);
      });

      (Array.isArray(isigIdx.list) ? isigIdx.list : []).forEach(function (item) {
        var entry = fromIsigmet(item, artcc);
        if (!entry || !isCurrentlyValid(entry, now)) return;
        var key = (entry.sequence || "") + "|" + (entry.id || "");
        if (seen[key] || (entry.sequence && seen[entry.sequence + "|"])) {
          // still allow if only sequence collision with different id path
        }
        if (seen[key]) return;
        // Skip if NWS already listed same series for this FIR
        var dup = entries.some(function (e) {
          return e.sequence && e.sequence === entry.sequence;
        });
        if (dup) return;
        seen[key] = true;
        entries.push(entry);
      });

      entries.sort(function (a, b) {
        var ae = parseTime(entryEnd(a));
        var be = parseTime(entryEnd(b));
        if (ae && be) return ae - be;
        return String(a.sequence).localeCompare(String(b.sequence));
      });

      return { artcc: artcc, entries: entries, error: null };
    });
  }

  global.EdstSigmets = {
    normalizeArtcc: normalizeArtcc,
    fetchSigmetsForArtcc: fetchSigmetsForArtcc,
  };
})(typeof window !== "undefined" ? window : globalThis);
