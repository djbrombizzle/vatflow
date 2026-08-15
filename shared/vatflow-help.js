/**
 * Shared help page overlay for VATFLOW tools.
 */

export const FCA_HELP = {
  title: "FCA Builder — Help",
  intro: "Draw flow constrained areas, meter traffic crossing a line, and issue ground releases. FCAs sync live via Supabase. Each FCA is owned by an ARTCC — scoped editors can only change programs for their facility.",
  quickstart: [
    { step: "1", text: "＋ New FCA — draw the line on the map" },
    { step: "2", text: "Set owning ARTCC, rate/MIT, and filters" },
    { step: "3", text: "Enable the FCA — controllers issue times in IDST" },
    { step: "→", text: 'Full staff flow + how to issue releases: <a href="FCA-howto.html">FCA How-To</a>' },
    { step: "→", text: 'DEL/GND/TWR guide: <a href="tower-rdy-guide.html">Tower RDY guide</a>' },
  ],
  nav: [
    { id: "fca-start", label: "Getting started" },
    { id: "fca-settings", label: "Settings" },
    { id: "fca-sequence", label: "Sequence" },
    { id: "fca-rdy", label: "RDY / Release" },
    { id: "fca-access", label: "Access" },
    { id: "fca-suite", label: "Suite" },
    { id: "fca-map", label: "Map" },
    { id: "fca-sync", label: "Sync" },
    { id: "fca-terms", label: "Terms" },
  ],
  sections: [
    {
      id: "fca-start",
      title: "Getting started",
      open: true,
      items: [
        "<b>View only</b> — browse FCAs, traffic, and sequences without signing in.",
        "<b>Sign in with VATSIM</b> — basic users can press <b>RDY</b>; whitelisted editors can create and edit FCAs for their ARTCC.",
        "<b>＋ New FCA</b> — click the map to place points (min 2). Double-click or press Enter to finish. Esc cancels.",
        "Set the owning <b>ARTCC</b> before saving (required for scoped editors).",
        "Select an FCA in the sidebar to open the <b>sequence panel</b> on the right.",
        "Toggle <b>Ground flights</b> in map layers to include connected taxiing aircraft (not prefiles).",
      ],
    },
    {
      id: "fca-settings",
      title: "FCA settings",
      items: [
        "<b>ARTCC</b> — owning facility for access control and list filters (e.g. ZDC).",
        "<b>Scope</b> — optional geographic metering filter (aircraft must be inside listed ARTCC(s)). Ownership ACL still uses the owning ARTCC field only.",
        "<b>Rate</b> — aircraft per hour across the line (e.g. 30/hr ≈ 2 min spacing).",
        "<b>MIT</b> — minimum miles in trail between crossings (converted to time from speed).",
        "Set destination / origin / fix filters and FL band to match the traffic you want.",
        "Aircraft are included only when their <b>filed route</b> crosses the FCA line.",
        "<b>Enable</b> the FCA when ready — disabled FCAs do not meter.",
      ],
    },
    {
      id: "fca-sequence",
      title: "Sequence panel",
      items: [
        "Airborne aircraft are ordered by <b>nm to the crossing</b> (closest first).",
        "Connected ground departures get a <b>release</b> (wheels-up time) from FCA spacing.",
        "Ground strips show <b>gap in minutes</b> behind the previous aircraft at the FCA crossing.",
        "<b>⠿ Drag</b> a strip to reorder when you can edit this FCA — times recompute for everyone.",
        "Reorder syncs via the shared FCA order (editors only — controllers issue times in <b>IDST</b>).",
        "<b>⧉ Copy</b> sends the sequence as plain text for coordination (Discord, etc.).",
        "Use the AIR / CFR / ALL chips to filter the display without changing the schedule.",
      ],
    },
    {
      id: "fca-rdy",
      title: "RDY / Release",
      items: [
        "<b>RDY</b> issues a frozen CFR release for a ground departure (wheels-up time).",
        "Optional <b>HHMMz</b> ready-time floor — release is at or after that time.",
        "Press RDY again (<b>RLSD ✕</b>) to cancel and return the aircraft to advisory sequencing.",
        "Signed-in users can RDY; creating/editing the FCA still requires ARTCC editor access.",
        "Controllers should issue releases from <b>IDST</b> (tower / APP / center filters).",
        'Tower-facing walkthrough: <a href="tower-rdy-guide.html">Tower RDY / Ready Time guide</a>.',
      ],
    },
    {
      id: "fca-access",
      title: "Access by ARTCC",
      items: [
        "Whitelisted <b>editors</b> may create/edit/delete only FCAs whose owning ARTCC matches their grant (e.g. ZDC-only).",
        "<b>Staff</b> for an ARTCC can whitelist editors for that facility on Admin Access — no global admin needed.",
        "Global editors (<code>*</code>) and global admins can edit any FCA.",
        "There are <b>no control passwords</b> — use Sign in with VATSIM.",
      ],
    },
    {
      id: "fca-suite",
      title: "Which tool do I use?",
      items: [
        "<b>FCA Builder</b> (this page) — draw/meter line FCAs and manage programs.",
        "<b>IDST</b> — controller Flights to Work desk for issuing CFR releases.",
        "<b>FCA Overview</b> — ARTCC map + multi-program strips (RDY / sequence).",
        "<b>Airport TMU</b> — destination capacity (AAR, CFR, restrictions, ground stops).",
        "<b>Runway Balancer</b> — arrival runway demand / STAR mapping (under Airport TMU).",
        "When Airport TMU shows <b>FCA PRGM</b>, FCA metering is authoritative for that departure.",
      ],
    },
    {
      id: "fca-map",
      title: "Map tips",
      items: [
        "<b>Click an aircraft</b> to plot its filed route through FAA NASR fixes, airways, and SID/STAR when known. Press Esc to clear.",
        "<b>Ctrl/⌘ + click</b> two points to measure distance in NM.",
        "Click a sector label or polygon (when sectors layer is on) to list aircraft inside.",
        "Use layer toggles for ARTCC boundaries, traffic, demo mode, and sector load colors.",
      ],
    },
    {
      id: "fca-sync",
      title: "Sync",
      items: [
        "FCAs save locally and sync to <b>Supabase</b> when configured.",
        "Everyone on the live site sees the same FCA list, order, and releases in realtime.",
        "<b>⤓ / ⤒</b> export or import FCA JSON for backup or offline events.",
      ],
    },
    {
      id: "fca-terms",
      title: "Key terms",
      items: [
        "<b>FCA</b> — Flow Constrained Area: a line that meters crossing traffic.",
        "<b>Release / RDY</b> — issued wheels-up time for a ground departure in an FCA sequence.",
        "<b>CFR</b> — Call For Release (Airport TMU destination metering; same idea as an FCA release).",
        "<b>MIT</b> — Miles in Trail between successive crossings.",
        "<b>Rate</b> — aircraft per hour across the FCA line.",
        "<b>Owning ARTCC</b> — facility tag that controls who may edit the FCA.",
      ],
    },
  ],
  footer: "For VATSIM simulation only — not for real-world ATC.",
};

export const FCA_OVERVIEW_HELP = {
  title: "FCA Overview — Help",
  intro: "ARTCC map of active FCA programs with a strip column to manage sequences and issue CFR / RDY for every program in scope.",
  quickstart: [
    { step: "1", text: "Select your ARTCC from the dropdown" },
    { step: "2", text: "Use STRIPS to show or hide the right-hand sequence column" },
    { step: "3", text: "Sign in and issue RDY / SET on ground strips (reorder needs ARTCC editor access)" },
    { step: "→", text: 'Controller guide: <a href="tower-rdy-guide.html">Tower RDY / Ready Time</a>' },
  ],
  nav: [
    { id: "ov-start", label: "Getting started" },
    { id: "ov-strips", label: "Strips" },
    { id: "ov-map", label: "Map" },
    { id: "ov-suite", label: "Suite" },
  ],
  sections: [
    {
      id: "ov-start",
      title: "Getting started",
      open: true,
      items: [
        "Select your <b>ARTCC</b> — the map zooms to that center and lists scoped / owned FCA programs.",
        "FCAs load from Supabase realtime (same as FCA Builder) with local cache fallback.",
        "Build or edit program geometry in <b>FCA Builder</b>. Issue desk also available in <b>IDST</b>.",
      ],
    },
    {
      id: "ov-strips",
      title: "Strip management",
      items: [
        "Toggle <b>STRIPS</b> in the top bar to show or hide the right-hand column.",
        "Each active FCA for the selected ARTCC gets its own strip stack (air + CFR).",
        "<b>RDY</b> / <b>SET</b> (HHMMz) issue CFR releases when signed in — same engine as IDST / Builder.",
        "Drag strips to reorder when you have ARTCC editor access for that program’s owning ARTCC.",
        "Use SHOW ALL / AIR ONLY / CFR ONLY to filter the lists without changing the schedule.",
      ],
    },
    {
      id: "ov-map",
      title: "Map",
      items: [
        "Active FCA lines for the selected ARTCC are drawn on the map.",
        "Traffic in those sequences appears for situational awareness.",
        "Click a strip to pan the map to that aircraft (or its departure field).",
      ],
    },
    {
      id: "ov-suite",
      title: "Which tool do I use?",
      items: [
        "<b>FCA Overview</b> (this page) — ARTCC map + multi-program strip management.",
        "<b>IDST</b> — Flights to Work desk for CFR / RDY.",
        "<b>FCA Builder</b> — draw lines, set rates/MIT, manage programs.",
        "<b>Airport TMU</b> — destination capacity CFRs (not line FCAs).",
      ],
    },
  ],
  footer: "For VATSIM simulation only — coordinate flow programs in FCA Builder.",
};

/** @deprecated alias — Release Board became FCA Overview */
export const ARTCC_DASHBOARD_HELP = FCA_OVERVIEW_HELP;
export const TOWER_HELP = FCA_OVERVIEW_HELP;

export const IDST_HELP = {
  title: "IDST — Help",
  intro: "Integrated Departure Scheduling Tool — Call For Release desk for FCA-metered ground departures. Set tower / approach / center filters (same as Airport TMU My Dashboard), then issue speakable wheels-up CFR times.",
  quickstart: [
    { step: "1", text: "Add airport, approach, and/or ARTCC filters for what you are working" },
    { step: "2", text: "Select a flight in Unscheduled" },
    { step: "3", text: "Sign in on position and press RDY (optional ART HHMMz)" },
    { step: "→", text: 'Guide: <a href="tower-rdy-guide.html">Tower RDY / Ready Time</a>' },
  ],
  nav: [
    { id: "idst-start", label: "Getting started" },
    { id: "idst-scope", label: "Filters" },
    { id: "idst-work", label: "Flights to Work" },
    { id: "idst-rdy", label: "RDY" },
    { id: "idst-suite", label: "Suite" },
  ],
  sections: [
    {
      id: "idst-start",
      title: "Getting started",
      open: true,
      items: [
        "IDST is the controller issuance desk for FCA programs — not the program builder.",
        "Only <b>FCA-metered</b> ground departures in your filter scope appear.",
        "APREQ mode on this tool is <b>Call For Release</b> (manual RDY).",
      ],
    },
    {
      id: "idst-scope",
      title: "Position filters",
      items: [
        "<b>Airport</b> — tower fields (e.g. KDCA).",
        "<b>Approach</b> — TRACON sector (e.g. A80, N90).",
        "<b>ARTCC</b> — center-wide airports inside the FIR (e.g. ZDC).",
        "Filters use the same device storage as Airport TMU <b>My Dashboard</b>.",
      ],
    },
    {
      id: "idst-work",
      title: "Flights to Work",
      items: [
        "<b>Unscheduled</b> — needs RDY; advisory hold only (not a clearance).",
        "<b>Released</b> — frozen CFR after RDY (green time is speakable).",
        "Select a row to open flight detail and issue/cancel.",
      ],
    },
    {
      id: "idst-rdy",
      title: "RDY",
      items: [
        "Sign in with VATSIM while online on a controller position to unlock RDY.",
        "Optional <b>ART HHMMz</b> sets the earliest wheels-up floor.",
        "Cancel with RLSD ✕ to return the flight to Unscheduled.",
      ],
    },
    {
      id: "idst-suite",
      title: "Which tool do I use?",
      items: [
        "<b>IDST</b> (this page) — issue CFR releases.",
        "<b>FCA Overview</b> — ARTCC map + strips.",
        "<b>FCA Builder</b> — create/enable programs.",
        "<b>Airport TMU</b> — destination capacity CFRs when no FCA applies.",
      ],
    },
  ],
  footer: "For VATSIM simulation only — not for real-world ATC.",
};

export const TMU_TOOLS_HELP = {
  title: "Airport TMU — Quick reference",
  intro: "Airport capacity TMU: destination AAR programs, ground stops, restrictions, and CFR issuance. Enroute/line FCAs are built in FCA Builder — this page surfaces FCA status and delegates releases when applicable.",
  sections: [
    {
      title: "Airport TMU vs FCA Builder",
      open: true,
      items: [
        "<b>Airport TMU</b> — destination capacity: AAR/trail/MIT, ground stops, route sequencing, and dest-based CFR.",
        "<b>FCA Builder</b> — line-based flow: draw FCAs, filters, line MIT/rate, crossing geometry.",
        "<b>IDST</b> — position-facing CFR / RDY for active FCA programs.",
        "<b>FCA Overview</b> — ARTCC map + strip management.",
        "When <b>FCA PRGM</b> is set on a departure, FCA metering is authoritative — READY/CFR routes to the FCA engine.",
      ],
    },
    {
      title: "Access by ARTCC",
      items: [
        "Whitelisted editors can set rates, restrictions, and ground stops only for airports in their ARTCC (e.g. ZDC → KDCA, KIAD, KBWI).",
        "Live sync pushes are merged on the server so a ZDC editor cannot overwrite another ARTCC’s programs.",
        "Sign in with VATSIM — no control passwords.",
      ],
    },
    {
      title: "Release priority",
      items: [
        "<b>1 — FCA program</b> (FCA PRGM column populated): FCA releases via Supabase / IDST.",
        "<b>2 — Route sequencing</b> (no FCA): departure release interval and issued-order compression.",
        "<b>3 — Airport capacity</b> (no FCA): destination AAR/trail/MIT.",
      ],
    },
    {
      title: "Ready time & CFR",
      items: [
        "<b>RDY @ (wheels-up earliest)</b> — enter HHMMz for the earliest CFR/wheels-up time; spacing may push later.",
        "One-click <b>RDY</b> / <b>CFR time</b> without a time uses the standard ready-now buffer.",
        "On FCA-metered aircraft, ready time is stored on the FCA release and syncs across FCA Builder and IDST.",
        'DEL/GND/TWR walkthrough: <a href="tower-rdy-guide.html">Tower RDY / Ready Time guide</a>.',
      ],
    },
  ],
  footer: "For VATSIM simulation only — not for real-world ATC.",
};

function renderHelpHtml(cfg) {
  const qs = (cfg.quickstart || []).length
    ? `<div class="vf-help-quick">` +
      cfg.quickstart.map(q => `<span><b>${q.step}.</b> ${q.text}</span>`).join("") +
      `</div>`
    : "";

  const nav = (cfg.nav || []).length
    ? `<nav class="vf-help-nav">` +
      cfg.nav.map(n => `<a href="#${n.id}">${n.label}</a>`).join("") +
      `</nav>`
    : "";

  const secs = (cfg.sections || []).map(s => {
    const items = (s.items || []).map(li => `<li>${li}</li>`).join("");
    const idAttr = s.id ? ` id="${s.id}"` : "";
    return `<details class="vf-help-sec"${s.open ? " open" : ""}><summary${idAttr}>${s.title}</summary><ul>${items}</ul></details>`;
  }).join("");

  return (
    `<div class="vf-help-head"><h2>${cfg.title}</h2><button type="button" class="vf-help-close" data-vf-help-close>Close</button></div>` +
    `<div class="vf-help-body">` +
    (cfg.intro ? `<p class="vf-help-intro">${cfg.intro}</p>` : "") +
    qs +
    `<div class="vf-help-layout">` + nav + `<div class="vf-help-main">` + secs + `</div></div>` +
    (cfg.footer ? `<p class="vf-help-foot">${cfg.footer}</p>` : "") +
    `</div>`
  );
}

/**
 * @param {HTMLElement|null} anchor — insert Help button before this element, or use as the button if it has data-vf-help-btn
 * @param {object} cfg — help content
 */
export function mountHelp(anchor, cfg) {
  let btn = null;
  if (anchor && anchor.matches && anchor.matches("[data-vf-help-btn]")) {
    btn = anchor;
  } else {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vf-help-btn";
    btn.textContent = "HELP";
    btn.title = "Open help page";
  }
  if (!btn.classList.contains("vf-help-btn")) btn.classList.add("vf-help-btn");
  if (!btn.textContent.trim()) btn.textContent = "HELP";

  const overlay = document.createElement("div");
  overlay.className = "vf-help-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", cfg.title || "Help");

  const panel = document.createElement("div");
  panel.className = "vf-help-panel vf-help-panel--page";
  panel.innerHTML = renderHelpHtml(cfg);
  overlay.appendChild(panel);

  function open() {
    overlay.classList.add("show");
    btn.classList.add("on");
    if (document.body.classList.contains("tower-page") || document.body.classList.contains("artcc-page")) {
      document.body.style.overflow = "hidden";
    }
  }
  function close() {
    overlay.classList.remove("show");
    btn.classList.remove("on");
    if (document.body.classList.contains("tower-page") || document.body.classList.contains("artcc-page")) {
      document.body.style.overflow = "";
    }
  }

  btn.addEventListener("click", () => overlay.classList.contains("show") ? close() : open());
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  panel.querySelector("[data-vf-help-close]")?.addEventListener("click", close);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && overlay.classList.contains("show")) close();
  });

  // In-panel nav: smooth scroll to section summaries
  panel.querySelectorAll(".vf-help-nav a").forEach(a => {
    a.addEventListener("click", e => {
      e.preventDefault();
      const id = a.getAttribute("href")?.slice(1);
      const target = id ? panel.querySelector("#" + id.replace(/[^a-zA-Z0-9_-]/g, "")) : null;
      if (!target) return;
      const details = target.closest("details");
      if (details) details.open = true;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  if (btn === anchor) {
    // already in DOM
  } else if (anchor && anchor.parentNode) {
    anchor.parentNode.insertBefore(btn, anchor);
  } else {
    document.body.appendChild(btn);
  }
  document.body.appendChild(overlay);
  return { btn, overlay, open, close };
}
