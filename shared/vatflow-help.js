/**
 * Shared quick-reference help overlay for VATFLOW tools.
 */

export const FCA_HELP = {
  title: "FCA TMU — Quick reference",
  intro: "Draw flow constrained areas, meter traffic crossing a line, and issue EDCTs for ground departures. FCAs sync live when Supabase is configured.",
  sections: [
    {
      title: "Getting started",
      open: true,
      items: [
        "<b>View only</b> — browse FCAs, traffic, and sequences. Unlock with the control password to edit.",
        "<b>＋ New FCA</b> — click the map to place points (min 2). Double-click or close the line to finish.",
        "Select an FCA in the sidebar to open the <b>sequence panel</b> on the right.",
        "Toggle <b>Ground flights (EDCT)</b> in map layers to include connected taxiing aircraft (not prefiles).",
      ],
    },
    {
      title: "FCA settings",
      items: [
        "<b>Rate</b> — aircraft per hour across the line (e.g. 30/hr ≈ 2 min spacing).",
        "<b>MIT</b> — minimum miles in trail between crossings (converted to time from speed).",
        "Set destination filters and FL band to match the traffic you want. Aircraft are included only when their <b>filed route</b> crosses the FCA line.",
        "<b>Enable</b> the FCA when ready — disabled FCAs do not meter.",
      ],
    },
    {
      title: "Sequence panel",
      items: [
        "Airborne aircraft are ordered by <b>nm to the crossing</b> (closest first); connected ground departures get <b>EDCT</b> (wheels-up time).",
        "Ground strips show <b>gap in minutes</b> behind the previous aircraft at the FCA crossing.",
        "<b>⠿ Drag</b> a strip to reorder — unlock controller mode first. Times recompute for everyone.",
        "Tower reorder on the ARTCC Dashboard syncs here via the shared FCA order.",
        "<b>⧉ Copy</b> sends the sequence as plain text for coordination (Discord, etc.).",
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
      title: "Sync & access",
      items: [
        "FCAs save locally and sync to <b>Supabase</b> when URL/key are configured in the file header.",
        "Controller password matches TBFM — unlock on any VATFLOW page if you use the shared password.",
        "<b>⤓ / ⤒</b> export or import FCA JSON for backup or offline events.",
      ],
    },
  ],
  footer: "For VATSIM simulation only — not for real-world ATC.",
};

export const ARTCC_DASHBOARD_HELP = {
  title: "ARTCC Dashboard — Quick reference",
  intro: "View FCA programs and metered departures for your ARTCC. EDCT is wheels-up time from FCA spacing (filed departure time is ignored).",
  sections: [
    {
      title: "Getting started",
      open: true,
      items: [
        "Select your <b>ARTCC</b> from the dropdown — the map zooms to that center and shows scoped FCA programs plus aircraft in those sequences.",
        "In <b>Release management</b>, enter an ARTCC code (e.g. ZDC) for center-wide departures, an airport (e.g. DCA, IAD), or <b>PCT</b> for metered departures at DCA, IAD, BWI, and RIC.",
        "Only <b>metered</b> departures appear — aircraft not in an active FCA program are hidden.",
        "FCAs load from Supabase realtime (same as FCA TMU) with local cache fallback.",
      ],
    },
    {
      title: "RDY and full control",
      items: [
        "<b>⚙ Settings</b> — sign in with VATSIM while online on a controller position to unlock <b>RDY</b>.",
        "<b>RDY</b> issues or cancels a CFR release for a ground departure in sequence.",
        "<b>Full control</b> (admin whitelist) adds drag-reorder, PIN, and HIDE for FCA blocks.",
      ],
    },
    {
      title: "Reading the strips",
      items: [
        "Strips show crossing time, distance to the FCA line, and estimated hold until <b>RDY</b> is pressed.",
        "After <b>RDY</b>, the strip shows the issued CFR time in green (<b>RLSD</b>).",
        "Drag strips to reorder when you have full control — order syncs to FCA TMU via Supabase.",
      ],
    },
  ],
  footer: "For VATSIM simulation only — coordinate with flow control via FCA TMU.",
};

export const TOWER_HELP = ARTCC_DASHBOARD_HELP;

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
