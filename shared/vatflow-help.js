/**
 * Shared quick-reference help overlay for VATFLOW tools.
 */

export const FCA_HELP = {
  title: "FCA Builder — Quick reference",
  intro: "Draw flow constrained areas, meter traffic crossing a line, and issue EDCTs for ground departures. FCAs sync live when Supabase is configured.",
  sections: [
    {
      title: "Getting started",
      open: true,
      items: [
        "<b>View only</b> — browse FCAs, traffic, and sequences. Unlock with the control password to edit.",
        "<b>＋ New FCA</b> — click the map to place points (min 2). Double-click or close the line to finish.",
        "Select an FCA in the sidebar to open the <b>sequence panel</b> on the right.",
        "Toggle <b>Ground flights (EDCT)</b> in map layers to include prefiles and taxiing aircraft.",
      ],
    },
    {
      title: "FCA settings",
      items: [
        "<b>Rate</b> — aircraft per hour across the line (e.g. 30/hr ≈ 2 min spacing).",
        "<b>MIT</b> — minimum miles in trail between crossings (converted to time from speed).",
        "Set <b>direction</b>, destination filters, and FL band to match only the traffic you want.",
        "<b>Enable</b> the FCA when ready — disabled FCAs do not meter.",
      ],
    },
    {
      title: "Sequence panel",
      items: [
        "Airborne aircraft are sequenced by ETA; ground departures get <b>EDCT</b> (wheels-up time).",
        "Ground strips show <b>gap in minutes</b> behind the previous aircraft at the FCA crossing.",
        "<b>⠿ Drag</b> a strip to reorder — unlock controller mode first. Times recompute for everyone.",
        "Tower reorder on the Tower Departures page syncs here via the shared FCA order.",
        "<b>⧉ Copy</b> sends the sequence as plain text for coordination (Discord, etc.).",
      ],
    },
    {
      title: "Map tips",
      items: [
        "<b>Click an aircraft</b> to plot its route. Press Esc to clear.",
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

export const TOWER_HELP = {
  title: "Tower Departures — Quick reference",
  intro: "See departures from your field metered against active FCAs from FCA Builder. EDCT is wheels-up time from FCA spacing (filed departure time is ignored).",
  sections: [
    {
      title: "Getting started",
      open: true,
      items: [
        "Enter your <b>FIELD</b> ICAO (e.g. KATL) and click <b>Load</b>.",
        "Departures appear when an <b>enabled FCA</b> in FCA Builder matches their route.",
        "Live traffic refreshes every ~20s from the VATSIM feed.",
        "FCAs load from Supabase realtime (same as FCA Builder) with local cache fallback.",
      ],
    },
    {
      title: "Unlocking controller mode",
      items: [
        "<b>⚙ Settings</b> — enter your VATSIM <b>CID</b> while online on a <b>_TWR</b> or <b>_GND</b> position, then Verify. No password needed.",
        "Verified position auto-fills your field ICAO when possible (e.g. KATL_TWR → KATL).",
        "Re-checked every feed refresh — log off position and access revokes within ~20s.",
        "<b>Password fallback</b> — View only → control password (same as TBFM/FCA Builder) for flow staff not on TWR/GND.",
      ],
    },
    {
      title: "Reading the table",
      items: [
        "<b>GAP</b> — minutes behind the previous aircraft at the FCA crossing (leader shows —).",
        "<b>CTA Z</b> — scheduled crossing time at the FCA in Zulu.",
        "<b>EDCT Z</b> — wheels-up / release time (CTA minus en-route time to the FCA).",
        "<b>GLOBAL #</b> — position in the full FCA sequence (all traffic, not just your field).",
        "<b>Not metered</b> — departure does not cross any active FCA on its filed route.",
      ],
    },
    {
      title: "Reordering departures",
      items: [
        "Unlock controller mode, then <b>⠿ drag</b> the # column to reorder.",
        "Reorder updates the <b>global FCA sequence</b> in FCA Builder (synced via Supabase).",
        "Gap and EDCT times recompute relative to the new order and FCA rate/MIT.",
        "Only reorder rows with the <b>same FCA</b> — multi-FCA rows show the most restrictive EDCT.",
      ],
    },
  ],
  footer: "For VATSIM simulation only — coordinate with flow control via FCA Builder.",
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
    if (document.body.classList.contains("tower-page")) document.body.style.overflow = "hidden";
  }
  function close() {
    overlay.classList.remove("show");
    btn.classList.remove("on");
    if (document.body.classList.contains("tower-page")) document.body.style.overflow = "";
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
