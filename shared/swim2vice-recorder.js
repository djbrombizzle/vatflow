/**
 * SWIM to vICE — feed recorder.
 *
 * Paste this into the browser console on a page showing a live traffic feed. It
 * writes down every message the page receives and hands you an NDJSON file to
 * load into the SWIM to vICE converter. It reads; it never sends anything.
 *
 * The page is left alone otherwise: the hooks pass every value through
 * untouched, and swimRecorder.stop() puts the originals back.
 *
 * Console:
 *   swimRecorder.stats()   what has been captured
 *   swimRecorder.save()    download the recording so far
 *   swimRecorder.stop()    unhook and download
 */
(function () {
  "use strict";

  if (window.swimRecorder) {
    console.log("%cSWIM recorder is already running.", "color:#e8a838");
    window.swimRecorder.stats();
    return;
  }

  var MAX_FRAME_CHARS = 2000000; // one absurd frame should not end the recording
  var state = {
    frames: [],
    part: 1,
    frameCount: 0,
    bytes: 0,
    bytesThisPart: 0,
    startedMs: Date.now(),
    autosaveBytes: 20 * 1024 * 1024,
    stopped: false,
  };
  var seenEvents = typeof WeakSet === "function" ? new WeakSet() : null;

  function record(source, url, data) {
    if (state.stopped || typeof data !== "string" || !data) return;
    if (data.length > MAX_FRAME_CHARS) return;
    state.frames.push({ t: new Date().toISOString(), src: source, url: String(url || ""), data: data });
    state.frameCount++;
    state.bytes += data.length;
    state.bytesThisPart += data.length;
    if (state.bytesThisPart >= state.autosaveBytes) save(true);
    if (state.frameCount % 200 === 0) paint();
  }

  /* ---- hooks ---------------------------------------------------------- */

  var nativeWebSocket = window.WebSocket;
  var nativeFetch = window.fetch;
  var nativeXhrOpen = XMLHttpRequest.prototype.open;
  var nativeXhrSend = XMLHttpRequest.prototype.send;
  var nativeEventSource = window.EventSource;
  var messageDataDescriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");

  // Sockets the page opens from here on. A Proxy on the constructor keeps
  // WebSocket.OPEN, instanceof and the prototype chain working, which a wrapper
  // function would quietly break.
  if (typeof Proxy === "function") {
    window.WebSocket = new Proxy(nativeWebSocket, {
      construct: function (target, args) {
        var socket = new target(args[0], args[1]);
        try {
          socket.addEventListener("message", function (event) {
            if (seenEvents) {
              if (seenEvents.has(event)) return;
              seenEvents.add(event);
            }
            record("ws", args[0], typeof event.data === "string" ? event.data : null);
          });
        } catch (err) { /* a socket that refuses a listener is still the page's */ }
        return socket;
      },
    });
  }

  // Sockets that were already open before you pasted this. Nothing can add a
  // listener to those, but the page still has to read event.data to use them, so
  // reading it is what gets recorded — deduplicated, since a page is free to
  // read the same event twice.
  if (messageDataDescriptor && messageDataDescriptor.get) {
    try {
      Object.defineProperty(MessageEvent.prototype, "data", {
        configurable: true,
        enumerable: messageDataDescriptor.enumerable,
        get: function () {
          var value = messageDataDescriptor.get.call(this);
          try {
            var socket = this.currentTarget || this.target;
            if (socket instanceof nativeWebSocket && typeof value === "string") {
              if (!seenEvents || !seenEvents.has(this)) {
                if (seenEvents) seenEvents.add(this);
                record("ws", socket.url, value);
              }
            }
          } catch (err) { /* never let recording break the page's own read */ }
          return value;
        },
      });
    } catch (err) { /* older engines: new sockets are still covered above */ }
  }

  // Feeds that poll over HTTP instead of pushing over a socket.
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    return nativeFetch.apply(this, arguments).then(function (response) {
      try {
        var type = response.headers.get("content-type") || "";
        if (/json|text/i.test(type)) {
          response.clone().text().then(function (text) { record("fetch", url, text); }, function () {});
        }
      } catch (err) { /* an unreadable response is not worth a broken page */ }
      return response;
    });
  };

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__swimUrl = url;
    return nativeXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    xhr.addEventListener("load", function () {
      try {
        if (xhr.responseType === "" || xhr.responseType === "text") record("xhr", xhr.__swimUrl, xhr.responseText);
        else if (xhr.responseType === "json") record("xhr", xhr.__swimUrl, JSON.stringify(xhr.response));
      } catch (err) { /* as above */ }
    });
    return nativeXhrSend.apply(this, arguments);
  };

  if (typeof nativeEventSource === "function" && typeof Proxy === "function") {
    window.EventSource = new Proxy(nativeEventSource, {
      construct: function (target, args) {
        var source = new target(args[0], args[1]);
        try {
          source.addEventListener("message", function (event) {
            record("sse", args[0], typeof event.data === "string" ? event.data : null);
          });
        } catch (err) { /* as above */ }
        return source;
      },
    });
  }

  /* ---- saving --------------------------------------------------------- */

  function save(automatic) {
    if (!state.frames.length) {
      if (!automatic) console.log("%cNothing recorded yet.", "color:#e8a838");
      return 0;
    }
    var lines = new Array(state.frames.length);
    for (var i = 0; i < state.frames.length; i++) lines[i] = JSON.stringify(state.frames[i]);
    var blob = new Blob([lines.join("\n") + "\n"], { type: "application/x-ndjson" });

    var stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    var name = "swim-recording-" + stamp + "-part" + String(state.part).padStart(2, "0") + ".ndjson";
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    setTimeout(function () {
      URL.revokeObjectURL(link.href);
      link.remove();
    }, 30000);

    var saved = state.frames.length;
    state.frames = [];
    state.bytesThisPart = 0;
    state.part++;
    console.log("%cSaved " + name + " (" + saved + " frames)", "color:#4ade80");
    paint();
    return saved;
  }

  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    window.WebSocket = nativeWebSocket;
    window.fetch = nativeFetch;
    XMLHttpRequest.prototype.open = nativeXhrOpen;
    XMLHttpRequest.prototype.send = nativeXhrSend;
    if (nativeEventSource) window.EventSource = nativeEventSource;
    if (messageDataDescriptor) {
      try { Object.defineProperty(MessageEvent.prototype, "data", messageDataDescriptor); } catch (err) {}
    }
    save(false);
    if (hud && hud.parentNode) hud.remove();
    console.log("%cSWIM recorder stopped.", "color:#e8a838");
  }

  function stats() {
    var minutes = (Date.now() - state.startedMs) / 60000;
    var info = {
      frames: state.frameCount,
      megabytes: +(state.bytes / 1048576).toFixed(1),
      minutesRecording: +minutes.toFixed(1),
      unsavedFrames: state.frames.length,
      partsSaved: state.part - 1,
    };
    console.table(info);
    return info;
  }

  /* ---- on-page readout ------------------------------------------------ */

  var hud = document.createElement("div");
  hud.style.cssText = [
    "position:fixed", "right:12px", "bottom:12px", "z-index:2147483647",
    "background:#0e1319", "color:#d4dde6", "border:1px solid #e8a838", "border-radius:8px",
    "padding:10px 12px", "font:12px ui-monospace,Menlo,Consolas,monospace",
    "box-shadow:0 6px 24px rgba(0,0,0,.5)", "min-width:186px",
  ].join(";");
  hud.innerHTML =
    '<div style="color:#e8a838;letter-spacing:.1em;font-size:10px;margin-bottom:6px">SWIM RECORDER</div>' +
    '<div id="swimHudBody">starting…</div>' +
    '<div style="margin-top:8px;display:flex;gap:6px">' +
    '<button id="swimHudSave" style="flex:1;cursor:pointer;background:#e8a838;border:0;border-radius:4px;padding:5px;font:inherit;font-weight:600">Save</button>' +
    '<button id="swimHudStop" style="flex:1;cursor:pointer;background:#1e2834;color:#d4dde6;border:0;border-radius:4px;padding:5px;font:inherit">Stop</button>' +
    "</div>";

  function paint() {
    var body = document.getElementById("swimHudBody");
    if (!body) return;
    var minutes = Math.floor((Date.now() - state.startedMs) / 60000);
    body.innerHTML =
      state.frameCount.toLocaleString() + " frames<br>" +
      (state.bytes / 1048576).toFixed(1) + " MB &middot; " + minutes + " min" +
      (state.part > 1 ? "<br>" + (state.part - 1) + " part(s) saved" : "");
  }

  function mount() {
    document.body.appendChild(hud);
    document.getElementById("swimHudSave").onclick = function () { save(false); };
    document.getElementById("swimHudStop").onclick = stop;
    paint();
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
  setInterval(paint, 15000);

  window.swimRecorder = { save: function () { return save(false); }, stop: stop, stats: stats, state: state };

  console.log(
    "%cSWIM recorder armed.%c Messages are being written down.\n" +
    "If the numbers stay at zero, the page opened its connection before you pasted this — " +
    "reload the page and paste again, or force a reconnect from the Network tab (Offline, then Online).\n" +
    "swimRecorder.save() to download · swimRecorder.stop() to finish",
    "color:#4ade80;font-weight:bold", "color:inherit"
  );
})();
