/* VATFLOW Briefing — UI layer.
 * Parsing lives in parse.js (VFB_PARSE); this file does extraction, storage
 * and rendering only.
 */
(function () {
  'use strict';

  var P = window.VFB_PARSE;
  var COURIER_CW = 6.0;          // release body is Courier 10pt: 6.0pt per char
  var WINGSPAN_FT = 93;          // B717-200 — the only type this is built for
  var STORE_KEY = 'vfb.state.v1';

  var state = {
    model: null,
    rawPages: null,
    tab: 'dep',
    notes: {},                   // per-flight free text + checklist state
    flightKey: null,
    depRunway: null,
    arrRunway: null,
    showInapplicable: false,
    showInactive: false,
    timeShiftMin: 0,
    notamFilter: 'relevant'
  };

  /* ---------- tiny DOM helpers ---------- */

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function $(sel) { return document.querySelector(sel); }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function fmtNum(n) { return n === null || n === undefined ? '—' : n.toLocaleString(); }
  function txt(v, fallback) { return (v === null || v === undefined || v === '') ? (fallback || '—') : String(v); }

  /* ---------- storage (degrades at file://) ---------- */

  var storage = (function () {
    var ok = false;
    try {
      window.localStorage.setItem('vfb.probe', '1');
      window.localStorage.removeItem('vfb.probe');
      ok = true;
    } catch (e) { ok = false; }
    return {
      available: ok,
      load: function () {
        if (!ok) return {};
        try { return JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}'); }
        catch (e) { return {}; }
      },
      save: function (obj) {
        if (!ok) return false;
        try { window.localStorage.setItem(STORE_KEY, JSON.stringify(obj)); return true; }
        catch (e) { return false; }
      }
    };
  })();

  function persisted() { return storage.load(); }
  function persist() {
    if (!state.flightKey) return;
    var all = persisted();
    all[state.flightKey] = state.notes;
    all.__prefs = { mode: document.documentElement.getAttribute('data-mode') || 'night' };
    storage.save(all);
  }
  function noteVal(k) { return state.notes[k] || ''; }
  function setNote(k, v) { state.notes[k] = v; persist(); }

  /* ---------- PDF extraction ---------- */
  /* pdf.js emits a run of spaces as ONE item whose width encodes the run, so
   * lines are rebuilt on a fixed character grid. That preserves the release's
   * column alignment, which the table parsers depend on. */

  function buildLines(items) {
    var rows = new Map();
    items.forEach(function (it) {
      if (!it.str || !it.str.trim()) return;
      var y = Math.round(it.transform[5] * 2) / 2;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ col: Math.round((it.transform[4] - 50) / COURIER_CW), s: it.str });
    });
    var ys = Array.from(rows.keys()).sort(function (a, b) { return b - a; });
    return ys.map(function (y) {
      var line = rows.get(y).sort(function (a, b) { return a.col - b.col; });
      var buf = '';
      line.forEach(function (it) {
        var c = Math.max(0, it.col);
        if (buf.length < c) buf += new Array(c - buf.length + 1).join(' ');
        buf = buf.slice(0, c) + it.s;
      });
      return buf.replace(/\s+$/, '');
    }).join('\n');
  }

  function extractPdf(arrayBuffer, onProgress) {
    var pdfjsLib = window.pdfjsLib;
    pdfjsLib.GlobalWorkerOptions.workerPort = makeWorker();
    return pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise.then(function (doc) {
      var pages = [], routeLink = null, chain = Promise.resolve();
      var n = doc.numPages;
      for (var i = 1; i <= n; i++) {
        (function (pageNo) {
          chain = chain.then(function () {
            return doc.getPage(pageNo).then(function (page) {
              return Promise.all([page.getTextContent(), page.getAnnotations()])
                .then(function (res) {
                  pages[pageNo - 1] = buildLines(res[0].items);
                  (res[1] || []).forEach(function (a) {
                    var u = a.url || a.unsafeUrl || '';
                    if (u && u.indexOf('route?') >= 0) routeLink = u;
                  });
                  if (onProgress) onProgress(pageNo, n);
                });
            });
          });
        })(i);
      }
      return chain.then(function () { return { pages: pages, routeLink: routeLink }; });
    });
  }

  // The worker source is inlined in the page; spin it up from a blob so the
  // file works from file:// with no sibling assets.
  function makeWorker() {
    var src = document.getElementById('pdfjs-worker-src').textContent;
    var blob = new Blob([src], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
  }

  /* ---------- domain helpers ---------- */

  function flightKey(M) {
    return [M.carrier || 'XXX', M.flightNo || '0', M.dateDDMMM || '', M.release || ''].join('/');
  }

  // A wingspan-restricted NOTAM cannot apply to a 717.
  function appliesToUs(n) {
    return !(n.wingspanOverFt && WINGSPAN_FT <= n.wingspanOverFt);
  }
  function notamsFor(M, icao) {
    var st = (M.notams.stations || []).filter(function (s) { return s.icao === icao || s.iata === icao; });
    var out = [];
    st.forEach(function (s) { out = out.concat(s.notams); });
    return out;
  }
  function splitApplicable(list) {
    return {
      apply: list.filter(appliesToUs),
      skip: list.filter(function (n) { return !appliesToUs(n); })
    };
  }
  /* ---------- briefing time (planned, or shifted for a delay) ---------- */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function msToZ(ms) {
    if (ms === null || ms === undefined) return null;
    var d = new Date(ms);
    return pad2(d.getUTCHours()) + pad2(d.getUTCMinutes());
  }
  function hhmmMin(t) {
    if (!t) return 0;
    return parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(2, 4), 10);
  }
  function shiftText(min) {
    if (!min) return null;
    var s = min < 0 ? '-' : '+';
    var a = Math.abs(min);
    return s + Math.floor(a / 60) + ':' + pad2(a % 60);
  }

  // Everything time-sensitive is judged against these two instants. Shifting
  // moves both by the same amount: a delay does not change the flight time.
  function effRefs(M) {
    var shift = (state.timeShiftMin || 0) * 60000;
    var d = M.derived;
    var dep = d.refDepMs === null || d.refDepMs === undefined ? null : d.refDepMs + shift;
    var arr = d.refArrMs === null || d.refArrMs === undefined ? null : d.refArrMs + shift;
    return {
      depMs: dep, arrMs: arr,
      depZ: msToZ(dep) || d.refDepZ,
      arrZ: msToZ(arr) || d.refArrZ,
      shiftMin: state.timeShiftMin || 0
    };
  }

  function setShift(min) {
    state.timeShiftMin = min;
    setNote('time.shift', String(min));
    render();
  }

  // Duty limit from the flight plan addendum, on the release's own calendar.
  function lattMs(M, which) {
    var l = which === 'ext' ? M.times.latestTakeoffExtended : M.times.latestTakeoff;
    var p = M.preparedAt;
    if (!l || !p) return null;
    var MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    if (!(p.month in MONTHS)) return null;
    return Date.UTC(p.year, MONTHS[p.month], parseInt(l.day, 10),
      parseInt(l.timeZ.slice(0, 2), 10), parseInt(l.timeZ.slice(2, 4), 10));
  }

  function timeBar(M) {
    var eff = effRefs(M);
    var planned = M.derived.refDepZ;
    var bar = el('div', { class: 'timebar noprint' });

    bar.appendChild(el('div', { class: 'timebar-head' }, [
      el('span', { class: 'fieldlabel', text: 'Briefing for' }),
      el('span', { class: 'timebar-now' }, [
        el('b', { text: txt(eff.depZ) + 'Z' }),
        el('span', { class: 'dim', text: ' wheels-up  ·  ' }),
        el('b', { text: txt(eff.arrZ) + 'Z' }),
        el('span', { class: 'dim', text: ' touchdown' }),
        eff.shiftMin
          ? el('span', { class: 'amber', text: '   ' + shiftText(eff.shiftMin) + ' vs planned ' + txt(planned) + 'Z' })
          : el('span', { class: 'dim', text: '   as planned' })
      ])
    ]));

    var quick = el('div', { class: 'filterbar' });
    [['Planned', 0], ['+15', 15], ['+30', 30], ['+1h', 60], ['+2h', 120], ['+3h', 180]].forEach(function (o) {
      quick.appendChild(el('button', {
        type: 'button',
        'aria-pressed': String(eff.shiftMin === o[1]),
        text: o[0],
        onclick: function () { setShift(o[1]); }
      }));
    });

    // Type an actual wheels-up time instead of stepping.
    var input = el('input', {
      type: 'text', inputmode: 'numeric', maxlength: '4',
      placeholder: 'HHMM Z',
      'aria-label': 'Actual wheels-up time, Zulu'
    });
    input.value = '';
    var apply = el('button', {
      type: 'button', class: 'primary', text: 'Set',
      onclick: function () {
        var v = (input.value || '').replace(/\D/g, '');
        if (v.length !== 4 || !planned) return;
        var target = parseInt(v.slice(0, 2), 10) * 60 + parseInt(v.slice(2), 10);
        var base = parseInt(planned.slice(0, 2), 10) * 60 + parseInt(planned.slice(2), 10);
        var diff = target - base;
        if (diff < -720) diff += 1440;   // typed a time after midnight Z
        if (diff > 720) diff -= 1440;
        setShift(diff);
      }
    });
    quick.appendChild(el('span', { class: 'timebar-input' }, [input, apply]));
    bar.appendChild(quick);

    // A shifted takeoff can run past the duty limit — say so where it is set.
    var latt = lattMs(M, 'plain'), lattX = lattMs(M, 'ext');
    if (eff.depMs !== null && latt !== null && eff.depMs > latt) {
      var pastExt = lattX !== null && eff.depMs > lattX;
      bar.appendChild(el('div', { class: 'banner bad' }, [
        el('b', { text: 'Past the latest allowable takeoff time — ' }),
        'duty LATT is ' + M.times.latestTakeoff.day + '/' + M.times.latestTakeoff.timeZ + 'Z' +
        (M.times.latestTakeoffExtended
          ? ', ' + M.times.latestTakeoffExtended.day + '/' + M.times.latestTakeoffExtended.timeZ + 'Z with extension'
          : '') + '.' + (pastExt ? ' This is past the extension too.' : '')
      ]));
    }
    return bar;
  }

  var TIME_LABEL = {
    expired: 'no longer in effect',
    future: 'not yet in effect',
    'outside-daily': 'outside its daily window'
  };

  // Split by whether a NOTAM is in force at the briefing's reference time.
  // Anything whose validity did not parse cleanly counts as active, so an
  // unreadable window never hides a NOTAM.
  function partitionTime(list, refMs) {
    var active = [], inactive = [];
    list.forEach(function (n) {
      var s = P.notamStatus(n, refMs);
      if (s === 'active' || s === 'unknown') { n._timeStatus = null; active.push(n); }
      else { n._timeStatus = s; inactive.push(n); }
    });
    return { active: active, inactive: inactive };
  }

  function timeBanner(part, refZ, what) {
    if (!part.inactive.length) return null;
    return el('div', { class: 'banner good' }, [
      el('b', { text: part.inactive.length + ' NOTAM(s) hidden — ' }),
      'not in effect at ' + (refZ ? refZ + 'Z' : 'the briefed time') + ' (' + what + ').',
      el('div', {}, [
        el('button', {
          type: 'button', class: 'noprint',
          text: state.showInactive ? 'Hide them' : 'Show them anyway',
          onclick: function () { state.showInactive = !state.showInactive; render(); }
        })
      ])
    ]);
  }

  function forRunway(list, rwy) {
    if (!rwy) return list.filter(function (n) { return !n.runway; });
    return list.filter(function (n) { return n.runway === rwy; });
  }

  function windFor(M, which) {
    var m = which === 'dep' ? M.derived.latestOriginMetar : M.derived.latestDestMetar;
    return m && m.decoded ? m.decoded.wind : null;
  }

  function fieldCond(M, iata, rwy) {
    var fc = (M.wx.fieldConditions || []).filter(function (f) { return f.station === iata; })[0];
    if (!fc) return null;
    var hit = fc.runways.filter(function (r) { return r.runway.split('-')[0] === rwy; })[0];
    return hit || null;
  }

  /* ---------- reusable render pieces ---------- */

  function card(letter, title, sub, bodyNodes, open) {
    var d = el('details', { class: 'card' }, [
      el('summary', {}, [
        letter ? el('span', { class: 'letter', text: letter }) : null,
        el('span', {}, [
          el('div', { class: 'card-title', text: title }),
          sub ? el('div', { class: 'card-sub', text: sub }) : null
        ])
      ]),
      el('div', { class: 'card-body' }, bodyNodes)
    ]);
    if (open) d.setAttribute('open', '');
    return d;
  }

  function stat(label, value, cls) {
    return el('div', { class: 'stat ' + (cls || '') }, [
      el('b', { text: value }), el('span', { text: label })
    ]);
  }

  function kv(pairs) {
    var dl = el('dl', { class: 'kv' });
    pairs.forEach(function (p) {
      if (!p) return;
      dl.appendChild(el('dt', { text: p[0] }));
      dl.appendChild(el('dd', { text: p[1] === null || p[1] === undefined ? '—' : String(p[1]) }));
    });
    return dl;
  }

  function sec(title) { return el('h3', { class: 'sec', text: title }); }

  // Short single-line entry for plate figures (altitudes, courses, minima).
  function textField(key, label, placeholder) {
    var i = el('input', {
      type: 'text', placeholder: placeholder || '',
      oninput: function () { setNote(key, i.value); }
    });
    i.value = noteVal(key);
    return el('div', { class: 'field' }, [
      el('label', { class: 'fieldlabel', text: label }), i
    ]);
  }
  function fieldGrid(fields) {
    var g = el('div', { class: 'fieldgrid' });
    fields.forEach(function (f) { g.appendChild(textField(f[0], f[1], f[2])); });
    return g;
  }
  function subcard(title, sub, nodes, open) {
    var d = card(null, title, sub, nodes, open);
    d.className = 'card sub';
    return d;
  }

  function notesField(key, label, placeholder) {
    var ta = el('textarea', {
      placeholder: placeholder || '',
      oninput: function () { setNote(key, ta.value); }
    });
    ta.value = noteVal(key);
    return el('div', {}, [el('label', { class: 'fieldlabel', text: label }), ta]);
  }

  function checklist(key, items) {
    var wrap = el('div', {});
    items.forEach(function (item, i) {
      var id = key + '.' + i;
      var done = !!state.notes[id];
      var box = el('input', { type: 'checkbox' });
      box.checked = done;
      var row = el('label', { class: 'checkitem' + (done ? ' done' : '') }, [
        box, el('span', { text: item })
      ]);
      box.addEventListener('change', function () {
        state.notes[id] = box.checked;
        row.className = 'checkitem' + (box.checked ? ' done' : '');
        persist();
      });
      wrap.appendChild(row);
    });
    return wrap;
  }

  function notamList(list, opts) {
    opts = opts || {};
    if (!list.length) return el('p', { class: 'muted small', text: opts.empty || 'None.' });
    var wrap = el('div', {});
    list.forEach(function (n) {
      wrap.appendChild(el('div', { class: 'notam' }, [
        el('div', { class: 'notam-head' }, [
          el('span', { class: 'notam-id', text: n.id }),
          el('span', { class: 'notam-val', text: n.validity }),
          n.runway ? el('span', { class: 'tag rwy', text: 'RWY ' + n.runway }) : null,
          n.category ? el('span', { class: 'tag', text: n.category }) : null,
          n.closed ? el('span', { class: 'tag closed', text: 'closed' }) : null,
          n._timeStatus ? el('span', { class: 'tag stale', text: TIME_LABEL[n._timeStatus] || n._timeStatus }) : null
        ]),
        el('div', { class: 'notam-body', text: n.text })
      ]));
    });
    return wrap;
  }

  function runwayPicker(label, runways, current, onPick) {
    var bar = el('div', { class: 'filterbar' });
    runways.forEach(function (r) {
      var b = el('button', {
        type: 'button',
        'aria-pressed': String(current === r),
        text: r,
        onclick: function () { onPick(current === r ? null : r); }
      });
      bar.appendChild(b);
    });
    return el('div', {}, [el('label', { class: 'fieldlabel', text: label }), bar]);
  }

  function windBox(rwy, wind, extra) {
    if (!rwy) return el('p', { class: 'muted small', text: 'Select a runway to compute wind components.' });
    if (!wind) return el('p', { class: 'muted small', text: 'No decodable surface wind in the release.' });
    var c = P.windComponents(rwy, wind);
    if (!c) return el('p', { class: 'muted small', text: 'Wind is variable — no component computed.' });
    var xw = c.crosswind, gust = c.gustCrosswind;
    var row = el('div', { class: 'stat-row' }, [
      stat('Runway', rwy),
      stat(c.tailwind ? 'Tailwind' : 'Headwind',
        (c.tailwind ? c.tailwind : c.headwind) + ' kt',
        c.tailwind ? 'bad' : 'good'),
      stat('Crosswind ' + c.crosswindFrom, xw + ' kt' + (gust ? ' (G' + gust + ')' : ''), xw >= 20 ? 'bad' : xw >= 10 ? 'hi' : '')
    ]);
    var out = el('div', {}, [row]);
    if (extra) out.appendChild(extra);
    return out;
  }

  /* ---------- DEPARTURE (WARTS) ---------- */

  function renderDeparture(M) {
    var wrap = el('div', {});
    var eff = effRefs(M);
    wrap.appendChild(timeBar(M));

    wrap.appendChild(el('div', { class: 'threat noprint' }, [
      el('h2', { text: 'Highest threats to the departure & mitigation' }),
      (function () {
        var ta = el('textarea', {
          placeholder: 'Weather, security, terrain, degraded systems… and the plan for each.',
          oninput: function () { setNote('dep.threat', ta.value); }
        });
        ta.value = noteVal('dep.threat');
        return ta;
      })()
    ]));

    var cards = el('div', { class: 'cards' });

    /* --- W: weather / wind --- */
    var wbody = [];
    var originMetar = M.derived.latestOriginMetar;
    var depRwys = M.derived.originRunways || [];
    wbody.push(runwayPicker('Departure runway (from field-conditions report)', depRwys, state.depRunway, function (r) {
      state.depRunway = r; setNote('dep.runway', r || ''); render();
    }));
    wbody.push(windBox(state.depRunway, windFor(M, 'dep')));

    var fc = state.depRunway ? fieldCond(M, M.origin.iata, state.depRunway) : null;
    if (fc) {
      var bad = /WET|SNOW|ICE|SLUSH|WATER/i.test(fc.condition);
      wbody.push(el('div', { class: 'banner' + (bad ? ' bad' : ' good') }, [
        el('b', { class: 'mono', text: 'RWY ' + fc.runway + ': ' + fc.condition }),
        el('span', { class: 'mono small', text: '  coverage ' + fc.coverage + (fc.rcc ? '  ·  RCC ' + fc.rcc : '') })
      ]));
    }

    if (originMetar) {
      wbody.push(sec('Origin METAR — ' + originMetar.station));
      wbody.push(el('div', { class: 'raw', text: originMetar.raw }));
      if (originMetar.decoded) {
        wbody.push(el('p', { class: 'small', text: originMetar.decoded.summary }));
        var cat = originMetar.decoded.flightCategory;
        if (cat) wbody.push(el('span', { class: 'chip ' + (cat === 'VFR' ? 'ok' : cat === 'MVFR' ? 'warn' : 'bad'), text: cat }));
      }
      var lowVis = originMetar.decoded && originMetar.decoded.visibility &&
        !originMetar.decoded.visibility.plus && originMetar.decoded.visibility.sm < 1;
      if (lowVis) {
        wbody.push(el('div', { class: 'banner bad' }, [
          el('b', { text: 'Low visibility — ' }),
          'review SMGCS low-visibility taxi routes and low-vis takeoff procedures.'
        ]));
      }
    }

    (M.wx.originTaf || []).forEach(function (taf) {
      wbody.push(sec('Origin TAF — ' + taf.station + (taf.valid ? '  valid ' + taf.valid.from + '/' + taf.valid.to : '')));
      wbody.push(el('div', { class: 'raw', text: taf.header + '\n' + taf.periods.map(function (p) { return p.raw; }).join('\n') }));
    });

    if (M.tocWind) {
      wbody.push(sec('Climb / cruise'));
      wbody.push(kv([
        ['T/C wind', M.tocWind.dir + '° / ' + M.tocWind.speed + ' kt'],
        ['ISA deviation', (M.isaDev > 0 ? '+' : '') + M.isaDev + '°C'],
        ['Cruise', M.cruiseFL ? 'FL' + M.cruiseFL : '—']
      ]));
    }
    wbody.push(notesField('dep.w', 'Windshear / cold wx / low-vis notes'));
    cards.appendChild(card('W', 'Weather / Wind', 'takeoff mins · windshear · cold wx · low vis', wbody, true));

    /* --- A: abnormal / abort --- */
    var abody = [];
    if (M.mel.length) {
      abody.push(sec('MEL items — ship ' + txt(M.shipNo)));
      var ul = el('ul', { class: 'plain' });
      M.mel.forEach(function (item) {
        ul.appendChild(el('li', {}, [
          el('div', { class: 'mono amber', text: item.code }),
          el('div', { text: item.description }),
          item.expires ? el('div', { class: 'small muted mono', text: 'expires ' + item.expires.date + ' ' + item.expires.timeZ + 'Z' }) : null,
          item.procedure ? el('div', { class: 'small mono', text: 'FLT OPS PROC: ' + item.procedure }) : null
        ]));
      });
      abody.push(ul);
    } else {
      abody.push(el('p', { class: 'muted small', text: 'No MEL items on this release.' }));
    }

    // The dispatcher sometimes ties a wind limit to an MEL; surface that next
    // to the computed crosswind rather than leaving it in the remarks.
    var xwRemark = (M.remarks.dispatcher || []).filter(function (r) { return /CROSSWIND/i.test(r.text); });
    if (xwRemark.length) {
      var comp = state.depRunway ? P.windComponents(state.depRunway, windFor(M, 'dep')) : null;
      abody.push(el('div', { class: 'banner' }, [
        el('b', { text: 'MEL wind limitation — ' }),
        xwRemark.map(function (r) { return r.text; }).join(' '),
        comp ? el('div', { class: 'mono small', text: 'Computed now: ' + comp.crosswind + ' kt crosswind on ' + comp.runway + (comp.gustCrosswind ? ' (gust ' + comp.gustCrosswind + ')' : '') }) : null
      ]));
    }

    if (M.discrepancies.length) {
      abody.push(sec('Open discrepancies' + (M.discrepanciesAsOf ? ' — as of ' + M.discrepanciesAsOf.time + ' ' + M.discrepanciesAsOf.zone : '')));
      var dl = el('ul', { class: 'plain' });
      M.discrepancies.forEach(function (d) {
        dl.appendChild(el('li', {}, [
          el('span', { class: 'mono amber', text: d.code + (d.location ? ' @' + d.location : '') + ' ' }),
          el('span', { class: 'small', text: d.description })
        ]));
      });
      abody.push(dl);
    }

    abody.push(notesField('dep.transfer', 'Transfer of aircraft control'));
    abody.push(notesField('dep.rto', 'Rejected takeoff plan — reasons to reject, crew duties'));
    cards.appendChild(card('A', 'Abnormal / Abort', 'transfer of control · RTO plan · MEL review', abody));

    /* --- R: runway --- */
    var rbody = [];
    rbody.push(el('div', { class: 'stat-row' }, [
      stat('Takeoff wt', fmtNum(M.weights.tow) + ' lb'),
      stat('Landing wt', fmtNum(M.weights.ldw) + ' lb'),
      stat('Zero fuel wt', fmtNum(M.weights.zfw) + ' lb'),
      stat('Ramp wt', fmtNum(M.weights.ramp) + ' lb')
    ]));
    var origFc = (M.wx.fieldConditions || []).filter(function (f) { return f.station === M.origin.iata; })[0];
    if (origFc) {
      rbody.push(sec('Field conditions — ' + origFc.station + ' (updated ' + origFc.updated + ')'));
      var fl = el('ul', { class: 'plain' });
      origFc.runways.forEach(function (r) {
        fl.appendChild(el('li', { class: 'mono small' },
          [r.runway + '  ' + r.condition + '  coverage ' + r.coverage + (r.rcc ? '  RCC ' + r.rcc : '')]));
      });
      origFc.surfaces.forEach(function (s) {
        fl.appendChild(el('li', { class: 'mono small muted' }, [s.area + ': ' + s.condition]));
      });
      rbody.push(fl);
    }
    rbody.push(el('div', { class: 'banner' }, [
      'Runway lengths and structural weight limits are not in the release — brief them from the airport pages / performance.'
    ]));
    rbody.push(notesField('dep.rtf', 'Likely runway for a return to field'));
    cards.appendChild(card('R', 'Runway', 'length · surface · return-to-field', rbody));

    /* --- T: taxi / terrain / transition --- */
    var tbody = [];
    var originN = splitApplicable(notamsFor(M, M.origin.icao));
    var taxiAll = originN.apply.filter(function (n) { return n.mentionsTaxiway || (n.category === 'AIRPORT' && !n.runway); });
    var taxiPart = partitionTime(taxiAll, eff.depMs);
    var taxiN = taxiPart.active;
    tbody.push(el('div', { class: 'stat-row' }, [
      stat('Field elev', fmtNum(M.origin.elevation) + ' ft'),
      stat('Gate', txt(M.gate)),
      stat('In effect', String(taxiN.length), 'hi'),
      stat('Not in effect', String(taxiPart.inactive.length)),
      stat('Not for 717', String(originN.skip.length))
    ]));

    if (originN.skip.length) {
      tbody.push(el('div', { class: 'banner good' }, [
        el('b', { text: originN.skip.length + ' NOTAM(s) hidden — ' }),
        'wingspan restrictions above the 717’s ' + WINGSPAN_FT + ' ft span.',
        el('div', {}, [
          el('button', {
            type: 'button', class: 'noprint',
            text: state.showInapplicable ? 'Hide them' : 'Show them anyway',
            onclick: function () { state.showInapplicable = !state.showInapplicable; render(); }
          })
        ])
      ]));
      if (state.showInapplicable) tbody.push(notamList(originN.skip));
    }

    tbody.push(sec('Taxi & airport NOTAMs — ' + txt(M.origin.iata)));
    var depBanner = timeBanner(taxiPart, eff.depZ, 'evaluated at wheels-up');
    if (depBanner) tbody.push(depBanner);
    tbody.push(notamList(taxiN));
    if (state.showInactive && taxiPart.inactive.length) {
      tbody.push(sec('Not in effect at ' + txt(eff.depZ) + 'Z'));
      tbody.push(notamList(taxiPart.inactive));
    }

    var cityPairDep = (M.remarks.cityPair || []).filter(function (r) {
      return /CLEARANCE|STARTUP|WHEELS UP|TAXI|GATE/i.test(r.text);
    });
    if (cityPairDep.length) {
      tbody.push(sec('City pair — departure relevant'));
      var cl = el('ul', { class: 'plain' });
      cityPairDep.forEach(function (r) {
        cl.appendChild(el('li', { class: 'small' }, [el('span', { class: 'mono amber', text: r.id + ' ' }), r.text]));
      });
      tbody.push(cl);
    }

    var origRemarks = (M.remarks.airport || []).filter(function (s) { return s.icao === M.origin.icao; })[0];
    if (origRemarks && origRemarks.entries.length) {
      tbody.push(sec('Company airport remarks — ' + origRemarks.iata));
      var orl = el('ul', { class: 'plain' });
      origRemarks.entries.forEach(function (e) {
        orl.appendChild(el('li', { class: 'small' }, [el('span', { class: 'mono amber', text: e.id + ' ' }), e.text]));
      });
      tbody.push(orl);
    }

    tbody.push(el('div', { class: 'banner' }, [
      'Transition altitude 18,000 ft unless the airport pages say otherwise — this release does not publish one.'
    ]));
    tbody.push(notesField('dep.taxi', 'Hot spots · hold-short points · anticipated crossings · engine start sequence'));
    cards.appendChild(card('T', 'Taxi / Terrain / Transition', 'taxi plan · hot spots · crossings', tbody));

    /* --- S: SID / company --- */
    var sbody = [];
    sbody.push(kv([
      ['SID', txt(M.route.sid)],
      ['Route', txt(M.route.raw)],
      ['Cruise', M.cruiseFL ? 'FL' + M.cruiseFL : '—'],
      ['ATC callsign', txt(M.atcCallsign)],
      ['Cost index', txt(M.costIndex)],
      ['Squawk', txt(M.transponderCode)]
    ]));

    var sidN = originN.apply.filter(function (n) { return n.category === 'SID'; });
    if (sidN.length) {
      var mine = sidN.filter(function (n) { return M.route.sid && n.text.indexOf(M.route.sid.replace(/\d$/, '')) >= 0; });
      sbody.push(sec('SID NOTAMs' + (mine.length ? ' — affecting ' + M.route.sid : '')));
      sbody.push(notamList(mine.length ? mine : sidN));
      if (mine.length && sidN.length > mine.length) {
        sbody.push(el('p', { class: 'small dim', text: (sidN.length - mine.length) + ' other SID NOTAM(s) not matching ' + M.route.sid + '.' }));
      }
    }

    var flCap = (M.remarks.cityPair || []).filter(function (r) { return /MAX FL/i.test(r.text); });
    if (flCap.length) {
      sbody.push(el('div', { class: 'banner' }, [
        el('b', { text: 'Altitude cap — ' }), flCap.map(function (r) { return r.text; }).join(' ')
      ]));
    }

    if (M.route.fixList && M.route.fixList.length) {
      sbody.push(sec('Fix list'));
      sbody.push(el('div', { class: 'raw', text: M.route.fixList.join('  ') }));
    }
    sbody.push(notesField('dep.s', 'Automation · radio management · engine-out procedure'));
    cards.appendChild(card('S', 'SID / Company pages', 'departure · automation · engine out', sbody));

    wrap.appendChild(cards);
    return wrap;
  }

  /* ---------- ARRIVAL (NATS) ---------- */

  function renderArrival(M) {
    var wrap = el('div', {});
    var eff = effRefs(M);
    wrap.appendChild(timeBar(M));

    wrap.appendChild(el('div', { class: 'threat noprint' }, [
      el('h2', { text: 'Highest threats to the approach & mitigation' }),
      (function () {
        var ta = el('textarea', {
          placeholder: 'Weather, terrain, degraded systems, fuel state… and the plan for each.',
          oninput: function () { setNote('arr.threat', ta.value); }
        });
        ta.value = noteVal('arr.threat');
        return ta;
      })()
    ]));

    var arrRwys = M.derived.destRunways || [];
    wrap.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-body' }, [
        runwayPicker('Landing runway (from field-conditions report)', arrRwys, state.arrRunway, function (r) {
          state.arrRunway = r; setNote('arr.runway', r || ''); render();
        }),
        windBox(state.arrRunway, windFor(M, 'arr'))
      ])
    ]));

    var cards = el('div', { class: 'cards' });
    var destN = splitApplicable(notamsFor(M, M.dest.icao));

    /* --- N: NOTAMs --- */
    var nbody = [];
    var refArr = eff.arrMs, refArrZ = eff.arrZ;
    var rwyPart = partitionTime(
      state.arrRunway ? destN.apply.filter(function (n) { return n.runway === state.arrRunway; }) : [], refArr);
    var genPart = partitionTime(destN.apply.filter(function (n) { return !n.runway; }), refArr);
    var inactiveTotal = rwyPart.inactive.length + genPart.inactive.length;

    nbody.push(el('div', { class: 'stat-row' }, [
      stat('Total ' + txt(M.dest.iata), String(destN.apply.length)),
      stat('For RWY ' + (state.arrRunway || '—'), state.arrRunway ? String(rwyPart.active.length) : '—', 'hi'),
      stat('Airport-wide', String(genPart.active.length)),
      stat('Not in effect', String(inactiveTotal)),
      stat('Not for 717', String(destN.skip.length))
    ]));

    if (inactiveTotal) {
      nbody.push(el('div', { class: 'banner good' }, [
        el('b', { text: inactiveTotal + ' NOTAM(s) hidden — ' }),
        'not in effect at ' + (refArrZ ? refArrZ + 'Z' : 'the briefed time') + ' (evaluated at touchdown).',
        el('div', {}, [
          el('button', {
            type: 'button', class: 'noprint',
            text: state.showInactive ? 'Hide them' : 'Show them anyway',
            onclick: function () { state.showInactive = !state.showInactive; render(); }
          })
        ])
      ]));
    }

    if (state.arrRunway) {
      nbody.push(sec('NOTAMs for runway ' + state.arrRunway));
      nbody.push(notamList(rwyPart.active, { empty: 'No NOTAMs in effect for runway ' + state.arrRunway + ' at ' + txt(refArrZ) + 'Z.' }));
    } else {
      nbody.push(el('p', { class: 'muted small', text: 'Pick a landing runway above to filter the runway and approach NOTAMs.' }));
    }
    nbody.push(sec('Airport-wide NOTAMs'));
    nbody.push(notamList(genPart.active));

    if (state.showInactive && inactiveTotal) {
      nbody.push(sec('Not in effect at ' + txt(refArrZ) + 'Z'));
      nbody.push(notamList(rwyPart.inactive.concat(genPart.inactive)));
    }

    if (M.notams.enrouteNone) {
      nbody.push(el('div', { class: 'banner good', text: 'No enroute/waypoint NOTAMs on this release.' }));
    }

    if (M.remarks.dispatcher && M.remarks.dispatcher.length) {
      nbody.push(sec('Flight plan remarks'));
      var fpr = el('ul', { class: 'plain' });
      M.remarks.dispatcher.forEach(function (r) {
        fpr.appendChild(el('li', { class: 'small' }, [el('span', { class: 'mono amber', text: r.seq + '  ' }), r.text]));
      });
      nbody.push(fpr);
    }
    nbody.push(sec('Not on the release — brief from the aircraft'));
    nbody.push(notesField('arr.atis', 'ATIS advisories', 'Code, approach in use, runways, braking action, remarks…'));
    nbody.push(notesField('arr.chartchg', 'Chart change notices', 'Revisions affecting the arrival, approach or airport diagram'));
    cards.appendChild(card('N', 'NOTAMs', 'NOTAMs · ATIS · flight plan remarks · chart changes', nbody, true));

    /* --- A: arrival / approach / automation --- */
    var abody = [];
    abody.push(kv([
      ['STAR', txt(M.route.star)],
      ['Target landing', M.times.targetLandingWindow ? M.times.targetLandingWindow.from + 'Z – ' + M.times.targetLandingWindow.to + 'Z' : '—'],
      ['Planned on', M.times.plannedOnZ ? M.times.plannedOnZ + 'Z' : '—'],
      ['Planned in', M.times.plannedInZ ? M.times.plannedInZ + 'Z' : '—'],
      ['Alternates', M.destAlternates.length ? M.destAlternates.join(', ') : 'NONE']
    ]));

    var destMetar = M.derived.latestDestMetar;
    if (destMetar) {
      abody.push(sec('Destination METAR — ' + destMetar.station));
      abody.push(el('div', { class: 'raw', text: destMetar.raw }));
      if (destMetar.decoded) {
        abody.push(el('p', { class: 'small', text: destMetar.decoded.summary }));
        var cat = destMetar.decoded.flightCategory;
        if (cat) {
          abody.push(el('span', { class: 'chip ' + (cat === 'VFR' ? 'ok' : cat === 'MVFR' ? 'warn' : 'bad'), text: cat }));
          if (cat !== 'VFR') {
            abody.push(el('div', { class: 'banner' }, [
              el('b', { text: 'Instrument conditions — ' }),
              'conduct a full approach plate briefing in addition to the NATS items.'
            ]));
          }
        }
      }
    }
    (M.wx.destTaf || []).forEach(function (taf) {
      abody.push(sec('Destination TAF — ' + taf.station + (taf.valid ? '  valid ' + taf.valid.from + '/' + taf.valid.to : '')));
      abody.push(el('div', { class: 'raw', text: taf.header + '\n' + taf.periods.map(function (p) { return p.raw; }).join('\n') }));
    });

    var apprN = state.arrRunway
      ? partitionTime(destN.apply.filter(function (n) {
          return n.runway === state.arrRunway && /APPROACH/i.test(n.category || '');
        }), eff.arrMs).active
      : [];
    if (apprN.length) {
      abody.push(sec('Approach procedure NOTAMs — RWY ' + state.arrRunway));
      abody.push(notamList(apprN));
    }
    abody.push(sec('Arrival'));
    abody.push(notesField('arr.speedalt', 'Arrival airspeed and altitude restrictions', 'STAR crossing restrictions, speed control…'));

    // The full plate briefing is required in actual IMC or night VMC, so open
    // it by default whenever the destination is not reporting VFR.
    var destCat = destMetar && destMetar.decoded ? destMetar.decoded.flightCategory : null;
    var plateOpen = destCat !== null && destCat !== 'VFR';

    abody.push(subcard('Approach plate briefing',
      'designated approach · minima · missed approach' + (plateOpen ? '  ·  opened: destination is ' + destCat : ''), [
      fieldGrid([
        ['arr.appr.type', 'Designated approach', 'from the plate'],
        ['arr.appr.runway', 'Runway', state.arrRunway ? 'selected: ' + state.arrRunway : 'from the plate'],
        ['arr.appr.chart', 'Jeppesen chart number', 'from the plate'],
        ['arr.appr.chartdate', 'Chart date', 'from the plate'],
        ['arr.appr.navaid', 'Navaid / frequency', 'ident and freq'],
        ['arr.appr.ident', 'Runway identification', 'from the plate'],
        ['arr.appr.course', 'Inbound course', 'degrees'],
        ['arr.appr.iaa', 'Initial approach altitude', 'feet'],
        ['arr.appr.faf', 'FAP / FAF altitude', 'feet'],
        ['arr.appr.marker', 'Baro altitude at marker', 'feet, as required'],
        ['arr.appr.minima', 'Minima (DA/MDA/DDA/DH/AH)', 'type and value'],
        ['arr.appr.bugs', 'Altimeter bugs (radio / baro)', 'radio / baro']
      ]),
      sec('Notes & restrictions pertaining to the approach'),
      notesField('arr.appr.notes', 'Approach notes / restrictions', 'Inop components, cold temp corrections, NA notes from the NOTAMs above…'),
      sec('Configuration & automation'),
      notesField('arr.appr.config', 'Configuration plan', 'Flap setting, speed, autobrake…'),
      notesField('arr.automation', 'Type of approach and level of automation', 'Autoland / flight director / raw data, who flies, autopilot disconnect…'),
      sec('Missed approach plan'),
      notesField('arr.appr.missed', 'Go-around procedure, callouts, execution of the maneuver',
        'Climb to…, turn…, hold at…  ·  callouts  ·  who does what')
    ], plateOpen));

    abody.push(subcard('Runway information (10-9A)', 'lighting · landing distance · surface · width', [
      (function () {
        var fc = state.arrRunway ? fieldCond(M, M.dest.iata, state.arrRunway) : null;
        if (!fc) return el('p', { class: 'muted small', text: 'Select a landing runway to show its reported surface condition.' });
        var bad = /WET|SNOW|ICE|SLUSH|WATER/i.test(fc.condition);
        return el('div', { class: 'banner' + (bad ? ' bad' : ' good') }, [
          el('b', { class: 'mono', text: 'RWY ' + fc.runway + ': ' + fc.condition }),
          el('span', { class: 'mono small', text: '  coverage ' + fc.coverage + (fc.rcc ? '  ·  RCC ' + fc.rcc : '') })
        ]);
      })(),
      fieldGrid([
        ['arr.rwy.lighting', 'Approach and runway lighting', 'approach lights, HIRL, centerline'],
        ['arr.rwy.lda', 'Usable landing distance', 'feet'],
        ['arr.rwy.width', 'Non-standard runway width', 'if other than 150 ft']
      ]),
      notesField('arr.rwy.stopping', 'Runway conditions affecting stopping distance', 'Ungrooved, contaminated, RCC below 5, standing water…')
    ]));

    cards.appendChild(card('A', 'Arrival / Approach chart / Automation', 'STAR · plate briefing · runway info · automation', abody));

    /* --- T: transition level / terrain / taxi --- */
    var tbody = [];
    tbody.push(el('div', { class: 'stat-row' }, [
      stat('Field elev', fmtNum(M.dest.elevation) + ' ft'),
      stat('Transition', '18,000 ft')
    ]));
    var destFc = (M.wx.fieldConditions || []).filter(function (f) { return f.station === M.dest.iata; })[0];
    if (destFc) {
      tbody.push(sec('Field conditions — ' + destFc.station + ' (updated ' + destFc.updated + ')'));
      var dl2 = el('ul', { class: 'plain' });
      destFc.runways.forEach(function (r) {
        dl2.appendChild(el('li', { class: 'mono small' },
          [r.runway + '  ' + r.condition + '  coverage ' + r.coverage + (r.rcc ? '  RCC ' + r.rcc : '')]));
      });
      destFc.surfaces.forEach(function (s) {
        dl2.appendChild(el('li', { class: 'mono small muted' }, [s.area + ': ' + s.condition]));
      });
      tbody.push(dl2);
    }
    tbody.push(el('div', { class: 'banner' }, [
      'Transition level 18,000 ft unless the airport pages say otherwise — this release does not publish one.'
    ]));

    // SMGCS review is triggered by visibility below RVR 1200 (about 1/4 SM).
    var dv = destMetar && destMetar.decoded ? destMetar.decoded.visibility : null;
    if (dv && !dv.plus && dv.sm <= 1) {
      tbody.push(el('div', { class: 'banner bad' }, [
        el('b', { text: 'Low visibility at destination (' + dv.sm + ' SM) — ' }),
        'if below RVR 1200, review the SMGCS low-visibility taxi routes chart.'
      ]));
    }

    tbody.push(notesField('arr.terrain', 'Terrain considerations', 'If applicable'));
    tbody.push(sec('Taxi plan'));
    tbody.push(el('p', { class: 'small muted', text: 'The airport diagram (10-9) is the primary reference — the moving map does not carry every note or restriction. Where they disagree, the diagram or NOTAMs take precedence.' }));
    tbody.push(fieldGrid([
      ['arr.taxi.exit', 'Anticipated runway exit point', 'taxiway'],
      ['arr.taxi.hotspots', 'Hot spots', ''],
      ['arr.taxi.holdshort', 'Hold short points', ''],
      ['arr.taxi.crossings', 'Anticipated runway crossings', ''],
      ['arr.taxi.gate', 'Expected gate / ramp', M.gate ? 'release shows ' + M.gate : 'gate']
    ]));
    tbody.push(notesField('arr.taxi.abnormal', 'Abnormalities (NOTAMs, construction, 10-8 page)', 'Closures and construction affecting the taxi in'));
    tbody.push(notesField('arr.taxi', 'Expected taxi route', 'Runway exit to gate'));
    cards.appendChild(card('T', 'Transition level / Terrain / Taxi plan', 'transition level · terrain · taxi in', tbody));

    /* --- S: company pages --- */
    var sbody = [];
    var destRemarks = (M.remarks.airport || []).filter(function (s) { return s.icao === M.dest.icao; })[0];
    if (destRemarks && destRemarks.entries.length) {
      sbody.push(sec('Company airport remarks — ' + destRemarks.iata));
      var sl = el('ul', { class: 'plain' });
      destRemarks.entries.forEach(function (e) {
        sl.appendChild(el('li', { class: 'small' }, [el('span', { class: 'mono amber', text: e.id + ' ' }), e.text]));
      });
      sbody.push(sl);
    } else {
      sbody.push(el('p', { class: 'muted small', text: 'No company remarks for the destination on this release.' }));
    }
    if (M.remarks.cityPair && M.remarks.cityPair.length) {
      sbody.push(sec('City pair remarks'));
      var cpl = el('ul', { class: 'plain' });
      M.remarks.cityPair.forEach(function (r) {
        cpl.appendChild(el('li', { class: 'small' }, [el('span', { class: 'mono amber', text: r.id + ' ' }), r.text]));
      });
      sbody.push(cpl);
    }
    sbody.push(sec('Brief from the company pages'));
    sbody.push(notesField('arr.engineout', 'Engine out procedures', 'Refer to Company Pages'));
    sbody.push(notesField('arr.s', 'Other specific company information'));
    cards.appendChild(card('S', 'Specific company information', 'company pages', sbody));

    /* --- runway change re-brief --- */
    cards.appendChild(card('↻', 'Runway change re-brief', 'tap through after any runway change', [
      el('p', { class: 'small muted', text: 'If the approach briefing is already complete and the runway changes, re-brief:' }),
      checklist('arr.rwychange', [
        'Positive confirmation of the new runway established',
        'Navigation aids re-tuned and inbound course set',
        'FMS programmed correctly for the new runway',
        'Altimeter bugs changed for the modified approach clearance',
        'Transfer of control accomplished, if desired or required (CAT II/III)'
      ]),
      el('button', {
        type: 'button', class: 'noprint',
        text: 'Reset re-brief',
        onclick: function () {
          Object.keys(state.notes).forEach(function (k) {
            if (k.indexOf('arr.rwychange.') === 0) delete state.notes[k];
          });
          persist(); render();
        }
      })
    ]));

    wrap.appendChild(cards);
    return wrap;
  }

  /* ---------- PASSENGER ---------- */

  function renderPassenger(M) {
    var wrap = el('div', { class: 'pa' });
    var d = M.derived;
    var destMetar = d.latestDestMetar;
    var dec = destMetar && destMetar.decoded;

    wrap.appendChild(el('div', { class: 'stat-row' }, [
      stat('Flight time', txt(d.eteText), 'hi'),
      stat('Block time', txt(d.blockText)),
      stat('Distance', fmtNum(M.distanceNM) + ' nm'),
      stat('Cruise', M.cruiseFL ? 'FL' + M.cruiseFL : '—')
    ]));

    // If the brief has been shifted for a delay, the announced arrival moves too.
    var eff = effRefs(M);
    var inLocal = M.times.plannedInL;
    if (eff.shiftMin && inLocal) {
      var base = parseInt(inLocal.slice(0, 2), 10) * 60 + parseInt(inLocal.slice(2), 10);
      var m2 = ((base + eff.shiftMin) % 1440 + 1440) % 1440;
      inLocal = pad2(Math.floor(m2 / 60)) + pad2(m2 % 60);
    }
    var inZ = eff.shiftMin && M.times.plannedInZ
      ? msToZ(M.derived.refArrMs === null ? null : M.derived.refArrMs + eff.shiftMin * 60000 +
          (hhmmMin(M.times.plannedInZ) - hhmmMin(M.derived.refArrZ)) * 60000)
      : M.times.plannedInZ;

    wrap.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-body' }, [
        sec('Arrival'),
        el('p', { class: 'lead' }, [
          eff.shiftMin ? 'Now estimating into ' : 'Planned into ',
          el('b', { text: txt(M.dest.name, txt(M.dest.iata)) }),
          ' at ', el('b', { class: 'mono', text: txt(inLocal) + ' local' }),
          inZ ? ' (' + inZ + 'Z)' : '',
          '.'
        ]),
        eff.shiftMin
          ? el('div', { class: 'banner' }, [
              el('b', { text: shiftText(eff.shiftMin) + ' on the release — ' }),
              'planned in was ' + txt(M.times.plannedInL) + ' local (' + txt(M.times.plannedInZ) + 'Z).'
            ])
          : null,
        M.times.tzDiffHrs !== undefined && M.times.tzDiffHrs !== null
          ? el('p', { class: 'small muted', text: 'Time zone difference: ' + (M.times.tzDiffHrs === 0 ? 'none' : (M.times.tzDiffHrs > 0 ? '+' : '') + M.times.tzDiffHrs + ' hr') })
          : null,
        sec('Weather at ' + txt(M.dest.iata)),
        dec ? el('p', { class: 'lead', text: dec.summary || '—' }) : el('p', { class: 'muted', text: 'No destination observation in the release.' }),
        dec && dec.tempC !== null
          ? el('p', { class: 'big', text: dec.tempC + '°C  /  ' + dec.tempF + '°F' })
          : null,
        destMetar ? el('p', { class: 'small dim mono', text: destMetar.station + ' ' + destMetar.raw }) : null
      ])
    ]));

    /* ride quality — only what is actually on our route */
    var rideCard = [];
    var pireps = d.onRoutePireps || [];
    if (pireps.length) {
      rideCard.push(el('p', {}, [
        el('b', { text: pireps.length + ' company PIREP(s) on our route' }),
        ' — ',
        pireps.map(function (p) { return p.fix; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', ')
      ]));
      var ul = el('ul', { class: 'plain' });
      pireps.forEach(function (p) {
        ul.appendChild(el('li', { class: 'small mono' }, [
          p.flight + '  ' + txt(p.fix) + '  ' + (p.flightLevel ? 'FL' + p.flightLevel : '') +
          (p.timeUtc ? '  ' + p.timeUtc : '')
        ]));
      });
      rideCard.push(ul);
    } else {
      rideCard.push(el('p', { class: 'muted', text: 'No company PIREPs on our route fixes.' }));
    }

    var tps = d.relevantTps || [];
    if (tps.length) {
      tps.forEach(function (o) {
        rideCard.push(el('div', { class: 'banner' }, [
          el('b', { text: txt(o.hazard, 'Advisory') + ' — ' }),
          (o.altitudes ? 'FL' + o.altitudes.fromFL + '–' + o.altitudes.toFL + ' ' + txt(o.altitudes.intensity, '') : ''),
          o.states ? ' over ' + o.states : ''
        ]));
      });
    }
    if (d.filteredTpsCount) {
      rideCard.push(el('p', { class: 'small dim', text: d.filteredTpsCount + ' turbulence advisory(s) hidden — outside our cruise level or route.' }));
    }
    if (M.winds.descent && M.winds.descent.length) {
      rideCard.push(sec('Descent winds'));
      rideCard.push(el('div', { class: 'raw', text: M.winds.descent.map(function (w) { return String(w.altitude).padStart(5, '0') + '  ' + w.raw; }).join('\n') }));
    }
    wrap.appendChild(card(null, 'Expected ride', 'PIREPs and advisories on our route', rideCard, true));

    /* cabin */
    var cabin = [];
    cabin.push(el('div', { class: 'stat-row' }, [
      stat('Passengers', fmtNum(M.weights.pax)),
      M.paxConfig ? stat('Config', M.paxConfig.first + '/' + M.paxConfig.main) : null,
      stat('Cargo', fmtNum(M.weights.cargo) + ' lb'),
      stat('Gate', txt(M.gate))
    ].filter(Boolean)));

    if (M.cabinBriefing.all && M.cabinBriefing.all.length) {
      cabin.push(sec('Preflight briefing — all flights'));
      cabin.push(checklist('pax.all', M.cabinBriefing.all.map(function (i) { return i.n + '. ' + i.text; })));
    }
    if (M.cabinBriefing.firstFlight && M.cabinBriefing.firstFlight.length) {
      cabin.push(sec('First flight of the day / after crew change'));
      cabin.push(checklist('pax.first', M.cabinBriefing.firstFlight.map(function (i) { return i.n + '. ' + i.text; })));
    }
    if (M.cabinBriefing.descent && M.cabinBriefing.descent.length) {
      cabin.push(sec('Descent briefing'));
      cabin.push(checklist('pax.descent', M.cabinBriefing.descent.map(function (i) { return i.n + '. ' + i.text; })));
    }
    wrap.appendChild(card(null, 'Cabin crew briefing', 'from the release briefing guide', cabin));

    /* PA note */
    wrap.appendChild(card(null, 'PA note', 'anything you want to add', [
      notesField('pax.pa', 'Your PA note', 'Delays, ride, connections, thanks…')
    ]));

    return wrap;
  }

  /* ---------- FLIGHT / RAW ---------- */

  function renderFlight(M) {
    var wrap = el('div', {});
    var cards = el('div', { class: 'cards two' });

    cards.appendChild(card(null, 'Release', null, [
      kv([
        ['Flight', txt(M.carrier) + ' ' + txt(M.flightNo) + ' / ' + txt(M.dateDDMMM)],
        ['Release', txt(M.release) + '  (' + txt(M.opsType) + ')'],
        ['Ship / reg', txt(M.shipNo) + ' / ' + txt(M.registration)],
        ['Type', txt(M.acType) + (M.wakeCat ? ' / ' + M.wakeCat : '')],
        ['Dispatcher', txt(M.dispatcher) + (M.dispatchDesk ? '  desk ' + M.dispatchDesk : '')],
        ['Phone', txt(M.dispatchPhone)],
        ['Route', txt(M.route.raw)],
        ['SELCAL', txt(M.selcal)],
        ['Equipment', txt(M.equipment)]
      ])
    ], true));

    cards.appendChild(card(null, 'Times', null, [
      kv([
        ['Sched out/in', txt(M.times.schedOutZ) + 'Z / ' + txt(M.times.schedInZ) + 'Z'],
        ['Planned out', txt(M.times.plannedOutZ) + 'Z  ' + txt(M.times.plannedOutL) + 'L'],
        ['Planned off', txt(M.times.plannedOffZ) + 'Z'],
        ['Planned on', txt(M.times.plannedOnZ) + 'Z'],
        ['Planned in', txt(M.times.plannedInZ) + 'Z  ' + txt(M.times.plannedInL) + 'L'],
        ['ETE', txt(M.derived.eteText)],
        ['Block', txt(M.derived.blockText)],
        ['Latest takeoff', M.times.latestTakeoff ? M.times.latestTakeoff.day + '/' + M.times.latestTakeoff.timeZ + 'Z' : '—'],
        ['  with extension', M.times.latestTakeoffExtended ? M.times.latestTakeoffExtended.day + '/' + M.times.latestTakeoffExtended.timeZ + 'Z' : '—']
      ])
    ], true));

    var F = M.fuel;
    cards.appendChild(card(null, 'Fuel', null, [
      el('div', { class: 'stat-row' }, [
        stat('Block', fmtNum(F.block), 'hi'),
        stat('Min for T/O', fmtNum(F.minTakeoff)),
        stat('Over minimum', fmtNum(M.derived.fuelOverMinimum), M.derived.fuelOverMinimum > 0 ? 'good' : 'bad')
      ]),
      kv([
        ['Taxi', F.taxi ? F.taxi.burn + ' lb / ' + P.fmtDur(F.taxi.timeMin) : '—'],
        ['Trip', F.trip ? F.trip.burn + ' lb / ' + P.fmtDur(F.trip.timeMin) : '—'],
        ['Reserve', F.reserve ? F.reserve.burn + ' lb / ' + P.fmtDur(F.reserve.timeMin) : '—'],
        ['Contingency', F.contingency ? F.contingency.burn + ' lb / ' + P.fmtDur(F.contingency.timeMin) : '—'],
        ['Planned landing', fmtNum(F.plannedLandingFuel) + ' lb'],
        ['Minimum landing', fmtNum(F.minimumLandingFuel) + ' lb'],
        ['Delay fuel', fmtNum(F.availDelayFuel) + ' lb' + (F.availDelay ? '  (' + F.availDelay.minutes + ' min at ' + F.availDelay.at + ')' : '')]
      ])
    ]));

    if (M.howgozit.length) {
      var rows = M.howgozit.map(function (h) {
        return [
          (h.fix || h.via || '').padEnd(8),
          (h.phaseOrFL || '').padEnd(7),
          String(h.legDistNM === null ? '' : h.legDistNM).padStart(4),
          ' ' + (h.groundSpeed === null ? '' : h.groundSpeed).toString().padStart(4),
          '  ' + (h.timeRemainingMin === null ? '' : P.fmtDur(h.timeRemainingMin)).padStart(5),
          '  ' + (h.fuelRemaining === null || h.fuelRemaining === undefined ? '' : h.fuelRemaining.toFixed(1)).padStart(6)
        ].join('');
      });
      cards.appendChild(card(null, 'HOWGOZIT', M.howgozit.length + ' points', [
        el('div', { class: 'raw', text: 'FIX     PHASE   DIST   GS   REMAIN   FUEL\n' + rows.join('\n') })
      ]));
    }

    if (M.crew.length) {
      cards.appendChild(card(null, 'Crew', null, [
        (function () {
          var ul = el('ul', { class: 'plain' });
          M.crew.forEach(function (c) {
            ul.appendChild(el('li', { class: 'small mono' }, [c.role + ' ' + c.position + '  ' + c.name]));
          });
          return ul;
        })()
      ]));
    }

    if (M.remarks.dispatcher.length) {
      cards.appendChild(card(null, 'Dispatcher remarks', null, [
        (function () {
          var ul = el('ul', { class: 'plain' });
          M.remarks.dispatcher.forEach(function (r) {
            ul.appendChild(el('li', { class: 'small' }, [el('span', { class: 'mono amber', text: r.seq + '  ' }), r.text]));
          });
          return ul;
        })()
      ]));
    }

    wrap.appendChild(cards);
    return wrap;
  }

  function renderRaw() {
    var wrap = el('div', {});
    wrap.appendChild(el('p', { class: 'small muted', text: 'Exactly what the parser read, page by page. Use this to confirm anything that looks wrong above.' }));
    (state.rawPages || []).forEach(function (p, i) {
      wrap.appendChild(card(null, 'Page ' + (i + 1), null, [el('div', { class: 'raw', text: p })]));
    });
    return wrap;
  }

  /* ---------- shell ---------- */

  function render() {
    var M = state.model;
    var head = $('#ident');
    clear(head);

    if (!M) {
      $('#tabbar').style.display = 'none';
      clear($('#main'));
      $('#main').appendChild(dropzone());
      return;
    }
    $('#tabbar').style.display = '';

    head.appendChild(el('span', { class: 'ident' }, [
      txt(M.carrier) + txt(M.flightNo),
      el('span', { class: 'sep', text: '·' }),
      txt(M.origin.iata) + ' → ' + txt(M.dest.iata)
    ]));
    head.appendChild(el('span', { class: 'sub', text: txt(M.dateDDMMM) + '  RLS ' + txt(M.release) + '  SHIP ' + txt(M.shipNo) + '  ' + txt(M.acType) }));

    var main = $('#main');
    clear(main);

    if (M.warnings && M.warnings.length) {
      main.appendChild(el('div', { class: 'banner bad' }, [
        el('b', { text: 'Parser warnings — ' }),
        M.warnings.join(' · ')
      ]));
    }

    if (state.tab === 'dep') main.appendChild(renderDeparture(M));
    else if (state.tab === 'arr') main.appendChild(renderArrival(M));
    else if (state.tab === 'pax') main.appendChild(renderPassenger(M));
    else if (state.tab === 'flt') main.appendChild(renderFlight(M));
    else main.appendChild(renderRaw());

    main.appendChild(el('footer', {}, [
      el('div', { text: 'Briefing aid only — the release and company procedures are the authority. Values here are parsed and may be wrong.' }),
      el('div', { text: 'Parsed on device. Nothing is uploaded.' + (storage.available ? '' : ' Notes will NOT persist in this context.') })
    ]));

    Array.prototype.forEach.call(document.querySelectorAll('#tabbar button'), function (b) {
      b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
    });
  }

  function dropzone() {
    var dz = el('div', { class: 'dropzone' }, [
      el('h2', { text: 'Load a flight release' }),
      el('p', { text: 'Drop the release PDF here, or pick it from Files. It is parsed on this device — nothing is uploaded.' }),
      el('button', { class: 'primary', type: 'button', text: 'Choose PDF', onclick: function () { $('#file').click(); } }),
      el('p', { class: 'small dim', id: 'progress', text: '' })
    ]);
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); });
    });
    dz.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });
    return dz;
  }

  function setStatus(text, cls) {
    var s = $('#status');
    s.textContent = text;
    s.className = 'chip ' + (cls || '');
  }

  function loadFile(file) {
    if (!file) return;
    setStatus('READING…', 'warn');
    var p = $('#progress');
    file.arrayBuffer().then(function (buf) {
      return extractPdf(buf, function (page, total) {
        if (p) p.textContent = 'Reading page ' + page + ' of ' + total + '…';
        setStatus('PAGE ' + page + '/' + total, 'warn');
      });
    }).then(function (res) {
      var M = P.parseRelease(res.pages, { routeLink: res.routeLink });
      state.model = M;
      state.rawPages = res.pages;
      state.flightKey = flightKey(M);
      var all = persisted();
      state.notes = all[state.flightKey] || {};
      state.depRunway = state.notes['dep.runway'] || null;
      state.arrRunway = state.notes['arr.runway'] || null;
      state.timeShiftMin = parseInt(state.notes['time.shift'] || '0', 10) || 0;
      state.tab = 'dep';
      setStatus(M.profile === 'icrew-mobile' ? 'PARSED ' + Math.round(M.confidence * 100) + '%' : 'UNKNOWN FORMAT',
        M.profile === 'icrew-mobile' && M.confidence > 0.7 ? 'ok' : 'warn');
      render();
    }).catch(function (err) {
      setStatus('FAILED', 'bad');
      var main = $('#main');
      clear(main);
      main.appendChild(el('div', { class: 'banner bad' }, [
        el('b', { text: 'Could not read that PDF. ' }),
        String(err && err.message || err)
      ]));
      main.appendChild(dropzone());
    });
  }

  /* ---------- offline status ---------- */

  function initOffline() {
    var chip = $('#offline');
    if (location.protocol === 'file:') {
      chip.textContent = 'LOCAL FILE';
      chip.className = 'chip ok';
      return;
    }
    if (!('serviceWorker' in navigator)) {
      chip.textContent = 'NO SW';
      chip.className = 'chip warn';
      return;
    }
    var swSrc = document.getElementById('sw-src').textContent;
    var url = URL.createObjectURL(new Blob([swSrc], { type: 'application/javascript' }));
    navigator.serviceWorker.register(url, { scope: './' }).then(function () {
      return navigator.serviceWorker.ready;
    }).then(function () {
      chip.textContent = 'OFFLINE READY';
      chip.className = 'chip ok';
    }).catch(function () {
      chip.textContent = 'ONLINE ONLY';
      chip.className = 'chip warn';
    });
  }

  /* ---------- boot ---------- */

  function init() {
    var prefs = persisted().__prefs || {};
    if (prefs.mode) document.documentElement.setAttribute('data-mode', prefs.mode);

    $('#file').addEventListener('change', function (e) {
      loadFile(e.target.files && e.target.files[0]);
      e.target.value = '';
    });
    $('#load').addEventListener('click', function () { $('#file').click(); });
    $('#mode').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-mode') === 'day' ? 'night' : 'day';
      document.documentElement.setAttribute('data-mode', cur);
      var all = persisted();
      all.__prefs = { mode: cur };
      storage.save(all);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#tabbar button'), function (b) {
      b.addEventListener('click', function () {
        state.tab = b.dataset.tab;
        render();
        window.scrollTo(0, 0);
      });
    });

    initOffline();
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
