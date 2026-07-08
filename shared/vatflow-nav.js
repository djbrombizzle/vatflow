/**
 * Shared VATFLOW app navigation (TBFM, FCA Builder, Tower Departures).
 * @param {HTMLElement|null} container
 * @param {"tbfm"|"fca"|"tower"|"runways"|"hub"} active
 */
export function mountVatflowNav(container, active) {
  if (!container) return;
  const links = [
    { id: "tbfm", href: "vatflow-tbfm%20v2.html", label: "CFR / TBFM" },
    { id: "fca", href: "FCA-builderv02.html", label: "FCA Builder" },
    { id: "tower", href: "tower-departures.html", label: "Tower Departures" },
    { id: "runways", href: "runway-balancer.html", label: "Runway Balancer" },
  ];
  const nav = document.createElement("nav");
  nav.className = "vatflow-app-nav";
  nav.setAttribute("aria-label", "VATFLOW apps");
  nav.innerHTML =
    `<span class="vf-brand"><b>VATFLOW</b></span>` +
    links.map(l =>
      `<a href="${l.href}"${l.id === active ? ' class="active" aria-current="page"' : ""}>${l.label}</a>`
    ).join("") +
  `<span class="vf-spacer"></span>`;
  container.appendChild(nav);
}
