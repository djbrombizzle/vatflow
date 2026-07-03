/**
 * Cross-page controller unlock persistence (classic script — no import required).
 * Include before app scripts on TBFM, FCA Builder, and Tower Departures.
 */
(function (global) {
  const LS_KEY = "vatflow.controllerUnlocked.v1";
  global.VatflowControl = {
    load() {
      try { return localStorage.getItem(LS_KEY) === "1"; } catch (_) { return false; }
    },
    save(on) {
      try {
        if (on) localStorage.setItem(LS_KEY, "1");
        else localStorage.removeItem(LS_KEY);
      } catch (_) {}
    },
    checkPassword(pw, localPassword) {
      return localPassword === "" || pw === localPassword;
    },
  };
})(window);
