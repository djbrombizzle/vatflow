/**
 * Shared VATFLOW app navigation — grouped dropdowns.
 */
import { initVatflowAuth, mountAuthNav } from "./vatflow-auth.js";

/**
 * @typedef {{ id: string, href: string, label: string }} NavLink
 * @typedef {{ id: string, label: string, children: NavLink[] }} NavGroup
 */

/** @type {(NavGroup|NavLink)[]} */
const NAV_ITEMS = [
  {
    id: "airport-tmu",
    label: "Airport TMU",
    children: [
      { id: "tbfm", href: "vatflow-tbfm%20v2.html", label: "Airport TMU" },
      { id: "runways", href: "runway-balancer.html", label: "Runway Balancer" },
    ],
  },
  {
    id: "flow",
    label: "Flow",
    children: [
      { id: "fca", href: "FCA-builderv02.html", label: "FCA Builder" },
      { id: "idst", href: "idst.html", label: "IDST" },
      { id: "artcc", href: "artcc-dashboard.html", label: "FCA Overview" },
      { id: "fca-acc", href: "fca-accuracy.html", label: "FCA Accuracy" },
    ],
  },
  {
    id: "center",
    label: "Center",
    children: [
      { id: "erids", href: "erids.html", label: "ERIDS" },
      { id: "swim2vice", href: "swim2vice.html", label: "SWIM \u2192 vICE" },
    ],
  },
  {
    id: "datalink",
    label: "Datalink",
    children: [
      { id: "vusalink", href: "vusalink/", label: "vUSAlink" },
      { id: "eram-trainer", href: "eram-trainer.html", label: "ERAM Trainer" },
      { id: "cpdlc-map", href: "cpdlc-map.html", label: "CPDLC Map" },
      { id: "hoppie-delay", href: "hoppie-delay.html", label: "Hoppie Delay" },
    ],
  },
  { id: "admin", href: "admin-access.html", label: "Admin Access" },
];

function resolveHref(base, href, id) {
  if (id === "vusalink" && base) return `${base}vusalink/`;
  return `${base}${href}`;
}

function childActive(group, active) {
  return group.children.some(c => c.id === active);
}

/**
 * @param {HTMLElement|null} container
 * @param {string} active — page id (tbfm|fca|idst|artcc|runways|…)
 * @param {{ base?: string }} [opts]
 */
export function mountVatflowNav(container, active, opts = {}) {
  if (!container) return;
  const base = opts.base || "";

  const nav = document.createElement("nav");
  nav.className = "vatflow-app-nav";
  nav.setAttribute("aria-label", "VATFLOW apps");

  let html = `<span class="vf-brand"><b>VATFLOW</b> <span class="vf-tagline">Traffic management for VATSIM · PERSONAL USE ONLY</span></span>`;

  for (const item of NAV_ITEMS) {
    if (item.children) {
      const open = childActive(item, active);
      html += `<div class="vf-dd${open ? " active" : ""}" data-dd="${item.id}">` +
        `<button type="button" class="vf-dd-btn${open ? " active" : ""}" aria-expanded="false" aria-haspopup="true">` +
        `${item.label}<span class="vf-dd-caret" aria-hidden="true">▾</span></button>` +
        `<div class="vf-dd-menu" role="menu">` +
        item.children.map(c => {
          const href = resolveHref(base, c.href, c.id);
          const isActive = c.id === active;
          return `<a role="menuitem" href="${href}"${isActive ? ' class="active" aria-current="page"' : ""}>${c.label}</a>`;
        }).join("") +
        `</div></div>`;
    } else {
      const href = resolveHref(base, item.href, item.id);
      html += `<a href="${href}"${item.id === active ? ' class="active" aria-current="page"' : ""}>${item.label}</a>`;
    }
  }

  html += `<span class="vf-spacer"></span>` +
    `<a class="vf-privacy" href="${base}privacy.html"${active === "privacy" ? ' class="active" aria-current="page"' : ""}>Privacy</a>`;

  nav.innerHTML = html;
  container.appendChild(nav);

  // Dropdown open/close — click toggles; outside click / Esc closes.
  // Do not close on clicks inside an open menu (that cancels <a> navigation
  // when the menu is display:none'd mid-click).
  function closeAllDropdowns() {
    nav.querySelectorAll(".vf-dd.open").forEach(x => {
      x.classList.remove("open");
      const b = x.querySelector(".vf-dd-btn");
      if (b) b.setAttribute("aria-expanded", "false");
    });
  }

  nav.querySelectorAll(".vf-dd").forEach(dd => {
    const btn = dd.querySelector(".vf-dd-btn");
    const menu = dd.querySelector(".vf-dd-menu");
    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      const wasOpen = dd.classList.contains("open");
      closeAllDropdowns();
      if (!wasOpen) {
        dd.classList.add("open");
        btn.setAttribute("aria-expanded", "true");
      }
    });
    if (menu) {
      menu.addEventListener("click", e => {
        // Keep the click on menuitem links; only stop bubbling to document.
        e.stopPropagation();
      });
    }
  });

  document.addEventListener("click", e => {
    if (e.target.closest && e.target.closest(".vatflow-app-nav .vf-dd.open")) return;
    closeAllDropdowns();
  });

  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    closeAllDropdowns();
  });

  initVatflowAuth().then(() => mountAuthNav(nav));
}
