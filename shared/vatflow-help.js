/**
 * Shared quick-reference help overlay for VATFLOW tools.
 */

export const FCA_HELP = {
  title: "FCA Builder — Quick reference",
  intro: "Draw flow constrained areas, meter traffic crossing a line, and issue ground releases. FCAs sync live via Supabase. Each FCA is owned by an ARTCC — scoped editors can only change programs for their facility.",
  sections: [
    {
      title: "Getting started",
      open: true,
      items: [
        "<b>View only</b> — browse FCAs, traffic, and sequences without signing in.",
        "<b>Sign in with VATSIM</b> — basic users can press <b>RDY</b>; whitelisted editors can create and edit FCAs for their ARTCC.",
        "<b>＋ New FCA</b> — click the map to place points (min 2). Double-click or close the line to finish. Set the owning <b>ARTCC</b> (required for scoped editors).",
        "Select an FCA in the sidebar to open the <b>sequence panel</b> on the right.",
        "Toggle <b>Ground flights</b> in map layers to include connected taxiing aircraft (not prefiles).",
      ],
    },
    {
      title: "FCA settings",
      items: [
        "<b>ARTCC</b> — owning facility for access control and list filters (e.g. ZDC).",
        "<b>Rate</b> — aircraft per hour across the line (e.g. 30/hr ≈ 2 min spacing).",
        "<b>MIT</b> — minimum miles in trail between crossings (converted to time from speed).",
        "Set destination filters and FL band to match the traffic you want. Aircraft are included only when their <b>filed route</b> crosses the FCA line.",
        "<b>Enable</b> the FCA when ready — disabled FCAs do not meter.",
      ],
    },
    {
      title: "Sequence panel",
      items: [
        "Airborne aircraft are ordered by <b>nm to the crossing</b> (closest first); connected ground departures get a <b>release</b> (wheels-up time).",
        "Ground strips show <b>gap in minutes</b> behind the previous aircraft at the FCA crossing.",
        "<b>⠿ Drag</b> a strip to reorder when you can edit this FCA. Times recompute for everyone.",
        "Reorder on the Release Board syncs here via the shared FCA order.",
        "<b>⧉ Copy</b> sends the sequence as plain text for coordination (Discord, etc.).",
      ],
    },
    {
      title: "Access by ARTCC",
      items: [
        "Whitelisted <b>editors</b> may create/edit/delete only FCAs whose owning ARTCC matches their grant (e.g. ZDC-only).",
        "<b>Staff</b> for an ARTCC can whitelist editors for that facility on Admin Access — no global admin needed.",
        "Global editors (<code>*</code>) and global admins can edit any FCA.",
      ],
    },
    {
      title: "Map tips",
      items: [
        "<b>Click an aircraft</b> to plot its filed route through FAA NASR fixes, airways, and SID/STAR when known. Press Esc to clear.",
        "<b>Ctrl/⌘ + click</b> two points to measure distance in NM.",
        "Click a sector label or polygon (when sectors layer is on) to list aircraft inside.",
        "Use layer toggles for ARTCC boundaries, traffic, demo mode, and sector load colors.",
      ],
    },
    {
      title: "Sync",
      items: [
        "FCAs save locally and sync to <b>Supabase</b> when configured.",
        "<b>⤓ / ⤒</b> export or import FCA JSON for backup or offline events.",
      ],
    },
  ],
  footer: "For VATSIM simulation only — not for real-world ATC.",
};

export const ARTCC_DASHBOARD_HELP = {
  title: "Release Board — Quick reference",
  intro: "View FCA programs and metered departures for your ARTCC. Release times are wheels-up from FCA spacing (filed departure time is ignored).",
  sections: [
    {
      title: "Getting started",
      open: true,
      items: [
        "Select your <b>ARTCC</b> from the dropdown — the map zooms to that center and shows scoped FCA programs plus aircraft in those sequences.",
        "In <b>Release management</b>, enter an ARTCC code (e.g. ZDC) for center-wide departures, an airport (e.g. DCA, IAD), or <b>PCT</b> for metered departures at DCA, IAD, BWI, and RIC.",
        "Only <b>metered</b> departures appear — aircraft not in an active FCA program are hidden.",
        "FCAs load from Supabase realtime (same as FCA Builder) with local cache fallback.",
      ],
    },
    {
      title: "RDY and full control",
      items: [
        "<b>Sign in with VATSIM</b> while online on a controller position to unlock <b>RDY</b>.",
        "<b>RDY</b> issues or cancels a CFR release for a ground departure in sequence.",
        "<b>Full control</b> (ARTCC whitelist) adds drag-reorder, PIN, and HIDE for FCA blocks you own.",
      ],
    },
    {
      title: "Reading the strips",
      items: [
        "Strips show crossing time, distance to the FCA line, and estimated hold until <b>RDY</b> is pressed.",
        "After <b>RDY</b>, the strip shows the issued CFR time in green (<b>RLSD</b>).",
        "Drag strips to reorder when you have full control for that FCA’s ARTCC — order syncs to FCA Builder via Supabase.",
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
  const secs = (cfg.sections || []).map(s => {
    const items = (s.items || []).map(li => `<li>${li}</li>`).join("");
    return `<details class="vf-help-sec"${s.open ? " open" : ""}><summary>${s.title}</summary><ul>${items}</ul></details>`;
  }).join("");
  return (
    `<div class="vf-help-head"><h2>${cfg.title}</h2><button type="button" class="vf-help-close" data-vf-help-close>Close</button></div>` +
    `<div class="vf-help-body">` +
    (cfg.intro ? `<p class="vf-help-intro">${cfg.intro}</p>` : "") +
    secs +
    (cfg.footer ? `<p class="vf-help-foot">${cfg.footer}</p>` : "") +
    `</div>`
  );
}

/**
 * @param {HTMLElement} anchor — insert Help button before this element (or append to parent)
 * @param {object} cfg — help content (FCA_HELP or TOWER_HELP)
 */
export function mountHelp(anchor, cfg) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "vf-help-btn";
  btn.textContent = "Help";
  btn.title = "Quick reference guide";

  const overlay = document.createElement("div");
  overlay.className = "vf-help-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", cfg.title || "Help");

  const panel = document.createElement("div");
  panel.className = "vf-help-panel";
  panel.innerHTML = renderHelpHtml(cfg);
  overlay.appendChild(panel);

  function open() {
    overlay.classList.add("show");
    btn.classList.add("on");
    if (document.body.classList.contains("tower-page") || document.body.classList.contains("artcc-page")) document.body.style.overflow = "hidden";
  }
  function close() {
    overlay.classList.remove("show");
    btn.classList.remove("on");
    if (document.body.classList.contains("tower-page") || document.body.classList.contains("artcc-page")) document.body.style.overflow = "";
  }

  btn.addEventListener("click", () => overlay.classList.contains("show") ? close() : open());
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  panel.querySelector("[data-vf-help-close]")?.addEventListener("click", close);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && overlay.classList.contains("show")) close(); });

  if (anchor && anchor.parentNode) {
    anchor.parentNode.insertBefore(btn, anchor);
  } else {
    document.body.appendChild(btn);
  }
  document.body.appendChild(overlay);
  return { btn, overlay, open, close };
}
