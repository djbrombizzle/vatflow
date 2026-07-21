/**
 * Shared help page overlay for VATFLOW tools.
 */

export const FCA_HELP = {
  title: "FCA Builder — Help",
  intro: "Draw flow constrained areas, meter traffic crossing a line, and issue ground releases. FCAs sync live via Supabase. Each FCA is owned by an ARTCC — scoped editors can only change programs for their facility.",
  quickstart: [
    { step: "1", text: "＋ New FCA — draw the line on the map" },
    { step: "2", text: "Set owning ARTCC, rate/MIT, and filters" },
    { step: "3", text: "Enable the FCA and use RDY on ground strips" },
    { step: "→", text: 'Full staff flow diagram: <a href="FCA-howto.html">FCA How-To</a>' },
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
        "Reorder on the Release Board syncs here via the shared FCA order.",
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
        "The same releases appear on the <b>Release Board</b> for tower/center positions.",
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
        "<b>Release Board</b> — ARTCC map + RDY for metered ground departures.",
        "<b>Airport TMU</b> — destination capacity (AAR, CFR, restrictions, ground stops).",
        "<b>Runway Balancer</b> — arrival runway demand / STAR mapping.",
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

export const ARTCC_DASHBOARD_HELP = {
  title: "Release Board — Help",
  intro: "Position-facing board for active FCA programs in your ARTCC. Issue and cancel releases (RDY) for metered ground departures. Release times are wheels-up from FCA spacing — filed departure time is ignored.",
  quickstart: [
    { step: "1", text: "Select your ARTCC from the dropdown" },
    { step: "2", text: "Load a filter (ZDC, DCA, or PCT)" },
    { step: "3", text: "Sign in on position and press RDY" },
  ],
  nav: [
    { id: "rb-start", label: "Getting started" },
    { id: "rb-filter", label: "Filters" },
    { id: "rb-rdy", label: "RDY" },
    { id: "rb-strips", label: "Strips" },
    { id: "rb-access", label: "Access" },
    { id: "rb-suite", label: "Suite" },
    { id: "rb-terms", label: "Terms" },
  ],
  sections: [
    {
      id: "rb-start",
      title: "Getting started",
      open: true,
      items: [
        "Select your <b>ARTCC</b> from the dropdown — the map zooms to that center and shows scoped FCA programs plus aircraft in those sequences.",
        "Only <b>metered</b> departures appear — aircraft not in an active FCA program are hidden.",
        "FCAs load from Supabase realtime (same as FCA Builder) with local cache fallback.",
        "Build or edit FCA programs in <b>FCA Builder</b> — this board is for releases and sequencing on position.",
      ],
    },
    {
      id: "rb-filter",
      title: "Release filters",
      items: [
        "Enter an <b>ARTCC</b> code (e.g. ZDC) for center-wide metered departures.",
        "Enter an <b>airport</b> (e.g. DCA, IAD) for that field only.",
        "Enter <b>PCT</b> for FCA-metered departures at DCA, IAD, BWI, and RIC.",
        "Press <b>Load</b> (or Enter) to apply the filter.",
      ],
    },
    {
      id: "rb-rdy",
      title: "RDY and full control",
      items: [
        "<b>Sign in with VATSIM</b> while online on a controller position to unlock <b>RDY</b>.",
        "Open <b>⚙ Settings</b> to see ATC verification status.",
        "<b>RDY</b> issues or cancels a CFR release for a ground departure in sequence.",
        "<b>Full control</b> (ARTCC whitelist) adds drag-reorder, PIN, and HIDE for FCA blocks you own.",
        "PIN locks an FCA table’s position on the board; HIDE removes it from view until restored.",
      ],
    },
    {
      id: "rb-strips",
      title: "Reading the strips",
      items: [
        "Strips show crossing time, distance to the FCA line, and estimated hold until <b>RDY</b> is pressed.",
        "After <b>RDY</b>, the strip shows the issued CFR time in green (<b>RLSD</b>).",
        "Drag the # column to reorder when you have full control for that FCA’s ARTCC.",
        "Order syncs to FCA Builder via Supabase for everyone.",
      ],
    },
    {
      id: "rb-access",
      title: "Access",
      items: [
        "<b>View only</b> — not signed in.",
        "<b>RDY only</b> — signed in + online on a VATSIM controller position.",
        "<b>Full control</b> — ARTCC editor whitelist for the FCA’s owning facility.",
        "ARTCC <b>staff</b> can whitelist editors on Admin Access without a global admin.",
        "No control passwords — use Sign in with VATSIM.",
      ],
    },
    {
      id: "rb-suite",
      title: "Which tool do I use?",
      items: [
        "<b>Release Board</b> (this page) — position RDY for active FCAs.",
        "<b>FCA Builder</b> — draw lines, set rates/MIT, manage programs.",
        "<b>Airport TMU</b> — destination capacity CFRs (not line FCAs).",
        "If a departure is in an FCA program, use this board (or FCA Builder) for RDY — not Airport TMU capacity slots.",
      ],
    },
    {
      id: "rb-terms",
      title: "Key terms",
      items: [
        "<b>Release / RDY</b> — issued wheels-up time for a metered ground departure.",
        "<b>RLSD</b> — release already issued (green).",
        "<b>FCA</b> — Flow Constrained Area program from FCA Builder.",
        "<b>PCT</b> — Potomac TRACON cluster filter (DCA, IAD, BWI, RIC).",
        "<b>Owning ARTCC</b> — which facility’s editors may reorder that FCA block.",
      ],
    },
  ],
  footer: "For VATSIM simulation only — coordinate flow programs in FCA Builder.",
};

export const TOWER_HELP = ARTCC_DASHBOARD_HELP;

export const TMU_TOOLS_HELP = {
  title: "Airport TMU — Quick reference",
  intro: "Airport capacity TMU: destination AAR programs, ground stops, restrictions, and CFR issuance. Enroute/line FCAs are built in FCA Builder — this page surfaces FCA status and delegates releases when applicable.",
  sections: [
    {
      title: "Airport TMU vs FCA Builder",
      open: true,
      items: [
        "<b>Airport TMU</b> — destination capacity: AAR/trail/MIT, ground stops, route sequencing, and dest-based CFR.",
        "<b>FCA Builder</b> — line-based flow: draw FCAs, filters, line MIT/rate, crossing geometry, and releases via Supabase.",
        "<b>Release Board</b> — position-facing RDY for active FCA programs.",
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
        "<b>1 — FCA program</b> (FCA PRGM column populated): FCA releases via Supabase.",
        "<b>2 — Route sequencing</b> (no FCA): departure release interval and issued-order compression.",
        "<b>3 — Airport capacity</b> (no FCA): destination AAR/trail/MIT.",
      ],
    },
    {
      title: "Ready time & CFR",
      items: [
        "<b>RDY @ (wheels-up earliest)</b> — enter HHMMz for the earliest CFR/wheels-up time; spacing may push later.",
        "One-click <b>RDY</b> / <b>CFR time</b> without a time uses the standard ready-now buffer.",
        "On FCA-metered aircraft, ready time is stored on the FCA release and syncs across FCA Builder and Release Board.",
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
