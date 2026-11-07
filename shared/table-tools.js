/**
 * Sortable, filterable tables (Ramp page lists, Gate list).
 *
 * Header cells with data-col="<key>" sort on click: ascending, descending,
 * then back to the list's own order. A filter row under the header (shown
 * with the list's Filter button, or whenever a filter is set) narrows each
 * column by text: a row stays when every non-empty filter is found in that
 * column's text. Sort and filters are remembered per list in localStorage.
 *
 * Columns are described by getters: { key: r => value } or
 * { key: { sort: r => value, text: r => string } } when the sort value and
 * the shown text differ (an ETA sorts by minutes, filters on "12 min").
 */

const norm = v => String(v ?? "").toUpperCase();

/** Rows filtered by st.filters and sorted by st.sort / st.dir; unsorted rows keep their order. */
export function sortFilterRows(rows, cols, st) {
  const textOf = (k, r) => { const c = cols[k]; return norm(typeof c === "function" ? c(r) : c.text ? c.text(r) : c.sort(r)); };
  const sortOf = (k, r) => { const c = cols[k]; return typeof c === "function" ? c(r) : c.sort(r); };
  const filters = Object.entries(st.filters || {}).filter(([k, f]) => cols[k] && String(f || "").trim());
  let out = filters.length ? rows.filter(r => filters.every(([k, f]) => textOf(k, r).includes(norm(f).trim()))) : rows.slice();
  if (st.sort && cols[st.sort]) {
    const dir = st.dir === -1 ? -1 : 1;
    const blank = v => v == null || v === "" || (typeof v === "number" && !Number.isFinite(v));
    out = out.map((r, i) => [r, i]).sort(([a, i], [b, j]) => {
      const va = sortOf(st.sort, a), vb = sortOf(st.sort, b);
      // Blanks last whichever way the column sorts.
      if (blank(va) || blank(vb)) return blank(va) - blank(vb) || i - j;
      const c = typeof va === "number" && typeof vb === "number" ? va - vb
        : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" });
      return c * dir || i - j;
    }).map(([r]) => r);
  }
  return out;
}

/**
 * Wire a table's header for sorting and add its filter row.
 * table: <table> whose first header row has th[data-col]; id: storage key;
 * onChange: re-render callback; button: optional element that shows / hides the filters.
 * Returns { state, apply(rows, cols), active() }.
 */
export function tableTools(table, { id, onChange, button = null }) {
  const key = `vatflow.table.${id}`;
  let st = { sort: null, dir: 1, filters: {}, open: false };
  try { st = { ...st, ...JSON.parse(localStorage.getItem(key) || "{}") }; } catch (_) { /* private mode */ }
  const save = () => { try { localStorage.setItem(key, JSON.stringify(st)); } catch (_) { /* private mode */ } };
  const head = table.tHead.rows[0];
  const ths = [...head.cells];
  const anyFilter = () => Object.values(st.filters).some(f => String(f || "").trim());

  for (const th of ths) {
    if (!th.dataset.col) continue;
    th.classList.add("sortable");
    th.insertAdjacentHTML("beforeend", '<span class="sortInd"></span>');
    th.title = (th.title ? th.title + " · " : "") + "Click to sort; again to reverse; a third time for the list's own order";
    th.addEventListener("click", () => {
      const k = th.dataset.col;
      if (st.sort !== k) { st.sort = k; st.dir = 1; } else if (st.dir === 1) st.dir = -1; else st.sort = null;
      save(); paint(); onChange();
    });
  }
  const fr = table.tHead.insertRow();
  fr.className = "filterRow";
  for (const th of ths) {
    const td = document.createElement("th");
    if (th.dataset.col) {
      const inp = document.createElement("input");
      inp.type = "search";
      inp.placeholder = "filter";
      inp.autocomplete = "off";
      inp.spellcheck = false;
      inp.value = st.filters[th.dataset.col] || "";
      inp.setAttribute("aria-label", `Filter ${th.textContent.trim()}`);
      inp.addEventListener("input", () => { st.filters[th.dataset.col] = inp.value; save(); paint(); onChange(); });
      td.appendChild(inp);
    }
    fr.appendChild(td);
  }
  if (button) {
    button.addEventListener("click", () => {
      if (!fr.hidden) {
        // Closing clears the filters, so no row stays hidden out of sight.
        if (anyFilter()) {
          st.filters = {};
          for (const i of fr.querySelectorAll("input")) i.value = "";
          onChange();
        }
        st.open = false;
      } else st.open = true;
      save(); paint();
      if (st.open) fr.querySelector("input")?.focus();
    });
  }
  function paint() {
    for (const th of ths) {
      const ind = th.querySelector(".sortInd");
      if (ind) ind.textContent = st.sort === th.dataset.col ? (st.dir === -1 ? " ▼" : " ▲") : "";
      th.classList.toggle("sorted", st.sort === th.dataset.col);
    }
    fr.hidden = !(st.open || anyFilter());
    if (button) {
      button.classList.toggle("on", !fr.hidden);
      button.textContent = anyFilter() ? "Filter ●" : "Filter";
      button.title = anyFilter() ? "Filters are on: click to clear and hide them" : "Show a filter box for each column";
    }
  }
  paint();
  return {
    state: st,
    apply: (rows, cols) => sortFilterRows(rows, cols, st),
    active: () => !!st.sort || anyFilter(),
  };
}
