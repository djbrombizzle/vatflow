/**
 * Cross-page controller unlock persistence (classic script — no import required).
 * Include before app scripts on TBFM, FCA Builder, and Tower Departures.
 */
(function (global) {
  const LS_KEY = "vatflow.controllerUnlocked.v1";
  const LS_PAGE_PREFIX = "vatflow.controllerUnlocked.page.";
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
    loadPage(page) {
      try { return localStorage.getItem(LS_PAGE_PREFIX + page) === "1"; } catch (_) { return false; }
    },
    savePage(page, on) {
      try {
        if (on) localStorage.setItem(LS_PAGE_PREFIX + page, "1");
        else localStorage.removeItem(LS_PAGE_PREFIX + page);
      } catch (_) {}
    },
  };
})(window);
