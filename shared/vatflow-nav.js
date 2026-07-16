/**
 * Shared VATFLOW app navigation.
 */
import { initVatflowAuth, mountAuthNav } from "./vatflow-auth.js";

/**
 * @param {HTMLElement|null} container
 * @param {"tbfm"|"fca"|"artcc"|"tower"|"runways"|"vusalink"|"cpdlc-map"|"admin"|"hub"} active
 * @param {{ base?: string }} [opts] — prefix for hrefs when mounted from a subfolder (e.g. "../")
 */
export function mountVatflowNav(container, active, opts = {}) {
  if (!container) return;
  const base = opts.base || "";
  const links = [
    { id: "tbfm", href: "vatflow-tbfm%20v2.html", label: "Airport TMU" },
    { id: "fca", href: "FCA-builderv02.html", label: "FCA Builder" },
    { id: "artcc", href: "artcc-dashboard.html", label: "Release Board" },
    { id: "runways", href: "runway-balancer.html", label: "Runway Balancer" },
    { id: "vusalink", href: "vusalink/", label: "vUSAlink" },
    { id: "cpdlc-map", href: "cpdlc-map.html", label: "CPDLC Map" },
    { id: "admin", href: "admin-access.html", label: "Admin Access" },
  ];
  const nav = document.createElement("nav");
  nav.className = "vatflow-app-nav";
  nav.setAttribute("aria-label", "VATFLOW apps");
  nav.innerHTML =
    `<span class="vf-brand"><b>VATFLOW</b> <span class="vf-tagline">Traffic management for VATSIM · PERSONAL USE ONLY</span></span>` +
    links.map(l => {
      let href = `${base}${l.href}`;
      if (l.id === "vusalink" && base) href = `${base}vusalink/`;
      return `<a href="${href}"${l.id === active ? ' class="active" aria-current="page"' : ""}>${l.label}</a>`;
    }).join("") +
    `<span class="vf-spacer"></span>` +
    `<a class="vf-privacy" href="${base}privacy.html"${active === "privacy" ? ' class="active" aria-current="page"' : ""}>Privacy</a>`;
  container.appendChild(nav);
  initVatflowAuth().then(() => mountAuthNav(nav));
}
