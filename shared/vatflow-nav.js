/**
 * Shared VATFLOW app navigation.
 */
import { initVatflowAuth, mountAuthNav } from "./vatflow-auth.js";

/**
 * @param {HTMLElement|null} container
 * @param {"tbfm"|"fca"|"tower"|"runways"|"vusalink"|"admin"|"hub"} active
 */
export function mountVatflowNav(container, active) {
  if (!container) return;
  const links = [
    { id: "tbfm", href: "vatflow-tbfm%20v2.html", label: "CFR / TBFM" },
    { id: "fca", href: "FCA-builderv02.html", label: "FCA Builder" },
    { id: "tower", href: "tower-departures.html", label: "Tower Departures" },
    { id: "runways", href: "runway-balancer.html", label: "Runway Balancer" },
    { id: "vusalink", href: "vusalink/", label: "vUSAlink" },
    { id: "admin", href: "admin-access.html", label: "Admin Access" },
  ];
  const nav = document.createElement("nav");
  nav.className = "vatflow-app-nav";
  nav.setAttribute("aria-label", "VATFLOW apps");
  nav.innerHTML =
    `<span class="vf-brand"><b>VATFLOW</b> <span class="vf-tagline">TMU management for VATSIM · PERSONAL USE ONLY</span></span>` +
    links.map(l =>
      `<a href="${l.href}"${l.id === active ? ' class="active" aria-current="page"' : ""}>${l.label}</a>`
    ).join("") +
    `<span class="vf-spacer"></span>` +
    `<a class="vf-privacy" href="privacy.html"${active === "privacy" ? ' class="active" aria-current="page"' : ""}>Privacy</a>`;
  container.appendChild(nav);
  initVatflowAuth().then(() => mountAuthNav(nav));
}
