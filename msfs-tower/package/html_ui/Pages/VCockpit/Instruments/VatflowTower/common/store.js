/*
 * VATFLOW Tower Cab - settings that survive restarts (your CID, saved tower spots, which
 * app each screen shows). In the sim they go to the sim's own per-user storage
 * (GetStoredData / SetStoredData), in a browser to localStorage. Values are JSON.
 */
var VatflowStore = (function () {
  var mem = {};

  function raw(key) {
    try {
      if (typeof GetStoredData === "function") return GetStoredData(key) || "";
    } catch (e) { /* fall through */ }
    try {
      if (typeof localStorage !== "undefined") return localStorage.getItem(key) || "";
    } catch (e) { /* fall through */ }
    return mem[key] || "";
  }

  function get(key, dflt) {
    var s = raw("VATFLOW_" + key);
    if (!s) return dflt;
    try { return JSON.parse(s); } catch (e) { return dflt; }
  }

  function set(key, value) {
    var s = value === undefined || value === null ? "" : JSON.stringify(value);
    key = "VATFLOW_" + key;
    mem[key] = s;
    try {
      if (typeof SetStoredData === "function") { SetStoredData(key, s); return; }
    } catch (e) { /* fall through */ }
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, s);
    } catch (e) { /* memory only */ }
  }

  return { get: get, set: set };
})();
