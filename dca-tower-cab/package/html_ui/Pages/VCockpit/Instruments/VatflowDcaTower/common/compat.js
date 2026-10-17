/*
 * VATFLOW Tower Cab - fills in what MSFS's instrument browser (older than Chrome) may lack
 * for the bundled VATFLOW code: Array.prototype.flatMap / flat, Object.fromEntries,
 * Promise.prototype.finally, and fetch() done with XMLHttpRequest (what every cab screen
 * already uses successfully; supports method, headers and body; ignores signal).
 * Load it before the bundles.
 */
(function (g) {
  if (!Array.prototype.flat) {
    Array.prototype.flat = function (depth) {
      depth = depth === undefined ? 1 : depth;
      var out = [];
      (function add(arr, d) {
        for (var i = 0; i < arr.length; i++) {
          if (Array.isArray(arr[i]) && d > 0) add(arr[i], d - 1); else out.push(arr[i]);
        }
      })(this, depth);
      return out;
    };
  }
  if (!Array.prototype.flatMap) {
    Array.prototype.flatMap = function (fn, thisArg) { return Array.prototype.map.call(this, fn, thisArg).flat(1); };
  }
  if (!Object.fromEntries) {
    Object.fromEntries = function (entries) {
      var o = {};
      Array.from(entries).forEach(function (e) { o[e[0]] = e[1]; });
      return o;
    };
  }
  if (typeof Promise !== "undefined" && !Promise.prototype.finally) {
    Promise.prototype.finally = function (fn) {
      return this.then(function (v) { fn(); return v; }, function (e) { fn(); throw e; });
    };
  }
  g.VatflowXhrFetch = function (url, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(opts.method || "GET", url, true);
      var h = opts.headers || {};
      for (var k in h) { try { xhr.setRequestHeader(k, h[k]); } catch (e) { /* forbidden header */ } }
      xhr.timeout = 30000;
      xhr.onload = function () {
        var t = xhr.responseText;
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status,
          text: function () { return Promise.resolve(t); },
          json: function () { return Promise.resolve(JSON.parse(t)); } });
      };
      xhr.onerror = function () { reject(new Error("network error " + url)); };
      xhr.ontimeout = function () { reject(new Error("timeout " + url)); };
      xhr.send(opts.body || null);
    });
  };
  if (typeof window !== "undefined") window.fetch = g.VatflowXhrFetch;
})(typeof window !== "undefined" ? window : this);
