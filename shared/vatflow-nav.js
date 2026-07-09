/**
 * Shared VATFLOW app navigation (TBFM, FCA Builder, Tower Departures).
 * @param {HTMLElement|null} container
 * @param {"tbfm"|"fca"|"tower"|"runways"|"admin"|"hub"} active
 */
export function mountVatflowNav(container, active) {
  if (!container) return;
  const links = [
    { id: "tbfm", href: "vatflow-tbfm%20v2.html", label: "CFR / TBFM" },
    { id: "fca", href: "FCA-builderv02.html", label: "FCA Builder" },
    { id: "tower", href: "tower-departures.html", label: "Tower Departures" },
    { id: "runways", href: "runway-balancer.html", label: "Runway Balancer" },
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
}
