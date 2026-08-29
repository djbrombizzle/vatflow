/* VATFLOW Briefing — release parser (DOM-free, testable in Node)
 *
 * Input : array of page strings produced by the grid extractor (fixed-width,
 *         column positions preserved).
 * Output: normalized release model. Every field carries provenance so the UI
 *         can distinguish parsed data from data the pilot typed.
 */
(function (root) {
  'use strict';

  /* ---------- text normalization ------------------------------------- */

  // The release renders in Courier with NBSP padding and SOFT HYPHEN in place
  // of '-'. pdf.js normalizes most of it, but not on every version/platform,
  // so we do it defensively before a single regex touches the text.
  function normalizeText(s) {
    return String(s)
      .replace(/­/g, '-')   // soft hyphen -> hyphen
      .replace(/ /g, ' ')   // nbsp -> space
      .replace(/[‐-―]/g, '-')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+$/gm, '');
  }

  var SECTIONS = [
    'Flight Dispatch Release Acknowledgement',
    'Flight Dispatch Captain Copy',
    'Remarks',
    'Flight Ops Alerts',
    'HOWGOZIT',
    'Enroute Forecast Winds',
    'NOTAMS',
    'Aircraft Discrepancy Report',
    'Weather Briefing',
    'Crew Member List',
    'Flight Plan Addendum',
    'Captain/Flight Attendant Briefing Guide',
    'Flight Status',
    'Flight Attendant Rotation',
    'Pilot Rotation',
    'Load Route into FD Pro'
  ];

  var FOOTER_RE = /^\s*prepared by .* Page \d+ of \d+\s*$/i;

  // Each page opens with its section title (Helvetica header) and a running
  // "Flight NNNN, AAA to BBB, DDMMM" line. Split on those rather than on
  // geometry: the header text is stable across releases.
  function splitSections(pages) {
    var out = {}, order = [], current = null;
    SECTIONS.forEach(function (s) { out[s] = []; });

    pages.forEach(function (page) {
      var lines = page.split('\n');
      var head = null, bodyStart = 0;

      for (var i = 0; i < Math.min(lines.length, 4); i++) {
        var t = lines[i].trim().replace(/\s*\(cont\.\)\s*$/i, '');
        var hit = SECTIONS.indexOf(t);
        if (hit >= 0) { head = SECTIONS[hit]; bodyStart = i + 1; break; }
      }
      if (head) { current = head; if (order.indexOf(head) < 0) order.push(head); }
      if (!current) return; // table of contents page

      var body = lines.slice(bodyStart).filter(function (l) {
        if (FOOTER_RE.test(l)) return false;
        if (/^\s*Flight \d+, \w{3} to \w{3}, \d{2}\w{3}\s*$/.test(l)) return false;
        return true;
      });
      out[current] = out[current].concat(body);
    });

    var joined = {};
    Object.keys(out).forEach(function (k) { joined[k] = out[k].join('\n'); });
    joined.__order = order;
    return joined;
  }

  /* ---------- small helpers ------------------------------------------- */

  function grab(text, re, group) {
    var m = re.exec(text);
    return m ? (m[group === undefined ? 1 : group] || '').trim() : null;
  }
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = parseInt(String(v).replace(/[, ]/g, ''), 10);
    return isNaN(n) ? null : n;
  }
  // "  :42" / "1:42" / ":42" -> minutes
  function hhmm(v) {
    if (!v) return null;
    var m = /^\s*(\d*):(\d{2})\s*$/.exec(v);
    if (!m) return null;
    return (parseInt(m[1] || '0', 10)) * 60 + parseInt(m[2], 10);
  }
  function fmtDur(mins) {
    if (mins === null || mins === undefined) return null;
    var h = Math.floor(mins / 60), m = mins % 60;
    return h + '+' + (m < 10 ? '0' : '') + m;
  }
  // Body block between a banner heading and the next banner/divider.
  function block(text, startRe, endRe) {
    var s = startRe.exec(text);
    if (!s) return null;
    var rest = text.slice(s.index + s[0].length);
    if (endRe) {
      var e = endRe.exec(rest);
      if (e) rest = rest.slice(0, e.index);
    }
    return rest.replace(/^\n+/, '').replace(/\s+$/, '');
  }
  function nonEmpty(lines) {
    return lines.filter(function (l) { return l.trim() !== ''; });
  }
  function isDivider(l) { return /^[-* ]{10,}$/.test(l.trim()); }

  /* ---------- identity / dispatch ------------------------------------- */

  function parseCaptainCopy(t, M) {
    var star = grab(t, /^\*\s+FLT\s+(\d+)\/(\d{2}[A-Z]{3})\s+SHIP\s+(\d+)\s+(\w{3})-(\w{3})\s+(\w+)\s+RLS\s+(\d+)/m, 0);
    if (star) {
      var m = /^\*\s+FLT\s+(\d+)\/(\d{2}[A-Z]{3})\s+SHIP\s+(\d+)\s+(\w{3})-(\w{3})\s+(\w+)\s+RLS\s+(\d+)/m.exec(t);
      M.flightNo = m[1]; M.dateDDMMM = m[2]; M.shipNo = m[3];
      M.origin.iata = m[4]; M.dest.iata = m[5];
      M.opsType = m[6]; M.release = m[7];
    }

    M.carrier = grab(t, /^([A-Z]{3})\s+\d+\/\d{2}[A-Z]{3}\s+ETE-/m);
    M.eteMin = hhmm(grab(t, /ETE-\s*(\d*:\d{2})/));
    M.dispatcher = grab(t, /^([A-Z][A-Z' -]+?)\s{2,}DESK-(\d+)/m);
    M.dispatchDesk = grab(t, /DESK-(\d+)/);
    M.dispatchPhone = grab(t, /PHONE-([\d*]+)/);

    var pair = /^(\w{3})\/(\w{4})\/(.+?)\s+-\s+(\w{3})\/(\w{4})\/(.+?)\s*$/m.exec(t);
    if (pair) {
      M.origin.iata = pair[1]; M.origin.icao = pair[2]; M.origin.name = pair[3].trim();
      M.dest.iata = pair[4]; M.dest.icao = pair[5]; M.dest.name = pair[6].trim();
    }

    var sked = /^SCHEDULED\s+\w{3}\/\w{4}\s+(\d{4})Z-(\d{4})L\s+-\s+\w{3}\/\w{4}\s+(\d{4})Z-(\d{4})L/m.exec(t);
    if (sked) {
      M.times.schedOutZ = sked[1]; M.times.schedOutL = sked[2];
      M.times.schedInZ = sked[3];  M.times.schedInL = sked[4];
    }
    var plan = /^PLANNED\s+(\d{4})Z-(\d{4})L\s+(\d{4})Z-(\d{4})L/m.exec(t);
    if (plan) {
      M.times.plannedOutZ = plan[1]; M.times.plannedOutL = plan[2];
      M.times.plannedInZ = plan[3];  M.times.plannedInL = plan[4];
    }

    var altn = grab(t, /^DEST ALTN:\s*(.+?)\s*$/m);
    M.destAlternates = (!altn || /^NONE$/i.test(altn)) ? [] : altn.split(/[\s,]+/).filter(Boolean);

    var win = /TARGET LANDING WINDOW\s+\*+\s*(\d{4})Z\s*-\s*(\d{4})Z/.exec(t);
    if (win) M.times.targetLandingWindow = { from: win[1], to: win[2] };

    var acft = /^SHIP\s+\d+\s+([A-Z0-9]+)\/([A-Z])-([A-Z0-9]+)\/([A-Z0-9]+)\s*$/m.exec(t);
    if (acft) {
      M.acType = acft[1];
      M.wakeCat = acft[2];
      M.equipment = acft[3];
      M.surveillance = acft[4];
    }
    M.registration = grab(t, /REG\/([A-Z0-9]+)/);
    M.selcal = grab(t, /SEL\/([A-Z]+)/);
    M.pbn = grab(t, /PBN\/([A-Z0-9]+)/);
    M.transponderCode = grab(t, /CODE\/([A-Z0-9]+)/);
    M.perfCat = grab(t, /PER\/([A-Z])/);

    var elev = /^ELEVATION\s+\w{3}\/(\w{4})\s+(-?\d+)\s*FT\s+\w{3}\/(\w{4})\s+(-?\d+)\s*FT/m.exec(t);
    if (elev) { M.origin.elevation = num(elev[2]); M.dest.elevation = num(elev[4]); }

    // Filed route: the standalone line beginning with the origin ICAO.
    if (M.origin.icao && M.dest.icao) {
      var rre = new RegExp('^(' + M.origin.icao + '\\s+.*\\s+' + M.dest.icao + ')\\s*$', 'm');
      M.route.raw = grab(t, rre);
      if (M.route.raw) {
        var toks = M.route.raw.split(/\s+/);
        M.route.tokens = toks;
        // SID/STAR: procedure-shaped tokens adjacent to the endpoints.
        var procRe = /^[A-Z]{3,5}\d[A-Z]?$/;
        if (toks.length > 2 && procRe.test(toks[1])) M.route.sid = toks[1];
        if (toks.length > 2 && procRe.test(toks[toks.length - 2])) M.route.star = toks[toks.length - 2];
      }
    }

    M.atcCallsign = grab(t, /^ATC\/FMS FLT NO\s*-\s*(\S+)/m);
    M.acarsId = grab(t, /^ACARS USE\s+(\S+)/m);

    var fl = /^FL\s+(\d+)\s+T-O-C WINDS\s+(\d{5})\s+ISA\s+([PM])(\d+)/m.exec(t);
    if (fl) {
      M.cruiseFL = num(fl[1]);
      M.tocWind = { dir: num(fl[2].slice(0, 3)), speed: num(fl[2].slice(3)) };
      M.isaDev = (fl[3] === 'M' ? -1 : 1) * num(fl[4]);
    }
    var etenm = /^ETE-\s+(\d*:\d{2})\s+NM\s+(\d+)\s+TAS\s+(\d+)/m.exec(t);
    if (etenm) { M.eteMin = hhmm(etenm[1]); M.distanceNM = num(etenm[2]); M.tas = num(etenm[3]); }
    M.gate = grab(t, /^SCHEDULED GATE\s+(\S+)/m);
    M.costIndex = num(grab(t, /COST INDEX\s+(\d+)/));

    // weights & fuel headline figures
    var W = M.weights, F = M.fuel;
    W.pax = num(grab(t, /^PASSENGERS\s+(\d+)/m));
    W.cargo = num(grab(t, /^CARGO\s+(\d+)/m));
    W.zfw = num(grab(t, /^ZERO FUEL WT\s+(\d+)/m));
    W.ramp = num(grab(t, /^RAMP WT\s+(\d+)/m));
    W.tow = num(grab(t, /^TAKEOFF GROSS WT\s+(\d+)/m));
    W.ldw = num(grab(t, /^LANDING WT\s+(\d+)/m));
    F.block = num(grab(t, /^BLOCK FUEL\s+(\d+)/m));
    F.minTakeoff = num(grab(t, /^MIN FUEL FOR T\/O\s+(\d+)/m));
    F.fmsReserve = num(grab(t, /^FMS RESERVE FUEL\s+(\d+)/m));

    // fuel plan table: "LABEL   :MM/  BURN   [:MM/  BURN]"
    function fuelRow(label) {
      var re = new RegExp('^' + label + '.*?(\\d*:\\d{2})\\/\\s*(\\d+)(?:\\s+(\\d*:\\d{2})\\/\\s*(\\d+))?\\s*$', 'm');
      var m = re.exec(t);
      if (!m) return null;
      var r = { timeMin: hhmm(m[1]), burn: num(m[2]) };
      if (m[3]) r.discretionary = { timeMin: hhmm(m[3]), burn: num(m[4]) };
      return r;
    }
    // TAXI has only a discretionary column on this layout.
    var taxi = /^TAXI\s+(\d*:\d{2})\/\s*(\d+)\s*$/m.exec(t);
    if (taxi) F.taxi = { timeMin: hhmm(taxi[1]), burn: num(taxi[2]) };
    F.trip = fuelRow('TRIP');
    F.reserve = fuelRow('RESERVE FUEL');
    F.contingency = fuelRow('CONTINGENCY FUEL');
    F.taxiIn = fuelRow('TAXI IN');
    F.plannedLandingFuel = num(grab(t, /PLANNED LNDG FUEL AT DEST\s+\*+\s*(\d+)/));
    F.minimumLandingFuel = num(grab(t, /MINIMUM LNDG FUEL AT DEST\s+\*+\s*(\d+)/));
    F.availDelayFuel = num(grab(t, /AVAIL DELAY FUEL\s*\*+\s*(\d+)/));
    var delay = /WHICH IS\s+(\d+)\s+MINS AT\s+(\S+)/.exec(t);
    if (delay) F.availDelay = { minutes: num(delay[1]), at: delay[2] };

    var fixes = block(t, /^FIX LIST\s+/m, /^\*{10,}/m);
    if (fixes) M.route.fixList = fixes.split(/\s+/).filter(Boolean);

    var altnLine = grab(t, /^ALTN:\s*(.+?)\s*$/m);
    if (altnLine && !/^NONE$/i.test(altnLine)) M.fuel.alternateNote = altnLine;
  }

  /* ---------- remarks -------------------------------------------------- */

  function parseRemarks(t, M) {
    // MEL items: "01 M29-22-01 - DESCRIPTION" + optional "EXPIRES ..." line
    var melBlock = block(t, /^MEL ITEMS FOR SHIP NUMBER\s+\d+\s*$/m, /^-{20,}/m);
    if (melBlock) {
      var cur = null;
      melBlock.split('\n').forEach(function (l) {
        var m = /^\s*(\d{2})\s+([A-Z]?[\d-]+[A-Z]?)\s+-\s+(.*)$/.exec(l);
        if (m) {
          cur = { seq: m[1], code: m[2], description: m[3].trim(), expires: null, procedure: null };
          M.mel.push(cur);
          return;
        }
        if (!cur) return;
        var e = /EXPIRES\s+(\d{2}[A-Z]{3}\d{2})\s+AT\s+(\d{4})Z/.exec(l);
        if (e) { cur.expires = { date: e[1], timeZ: e[2] }; return; }
        if (l.trim()) cur.description += ' ' + l.trim();
      });
    }

    function numbered(name) {
      var b = block(t, new RegExp('^\\s*' + name + '\\s*$', 'm'), /^-{20,}/m);
      if (!b) return [];
      var items = [], cur = null;
      b.split('\n').forEach(function (l) {
        if (isDivider(l) || !l.trim()) return;
        var m = /^\s*(\d{2})\s+(.*)$/.exec(l);
        if (m) { cur = { seq: m[1], text: m[2].trim() }; items.push(cur); }
        else if (cur) cur.text += ' ' + l.trim();
        else items.push({ seq: null, text: l.trim() });
      });
      return items;
    }
    M.remarks.dispatcher = numbered('DISPATCHER REMARKS');
    M.remarks.flightOpsMaint = numbered('FLIGHT OPERATIONS AND MAINTENANCE REMARKS');

    // City pair remarks: "CLT-ATL N1917/17 24AUG171606Z-UFN" + body lines
    var cp = block(t, /^\s*DELTA CITY PAIR REMARKS\s*$/m, /^\s*DELTA AIRPORT REMARKS\s*$/m);
    if (cp) {
      var c = null;
      cp.split('\n').forEach(function (l) {
        if (isDivider(l)) return;
        var m = /^(\w{3}-\w{3})\s+(\S+)\s+(\S+)\s*$/.exec(l.trim());
        if (m) { c = { pair: m[1], id: m[2], validity: m[3], text: '' }; M.remarks.cityPair.push(c); return; }
        if (c && l.trim()) c.text = (c.text ? c.text + ' ' : '') + l.trim();
      });
      M.remarks.cityPair.forEach(function (r) { r.text = r.text.trim(); });
    }

    // Airport remarks, grouped per station.
    var ar = block(t, /^\s*DELTA AIRPORT REMARKS\s*$/m, /^\s*DELTA ALTERNATE AIRPORT REMARKS\s*$/m);
    if (ar) M.remarks.airport = parseStationRemarks(ar);

    var alt = block(t, /^\s*DELTA ALTERNATE AIRPORT REMARKS\s*$/m, /^\s*OVERFLT AUTHORIZATIONS\s*$/m);
    if (alt) M.remarks.alternateAirport = parseStationRemarks(alt);
  }

  var STATION_HEAD = /^\s*\*{3,}(\w{4})\/(\w{3})\s+-{1,2}\s+(.*?)\*{3,}\s*$/;
  // "***01L***" scopes the entries that follow to one runway; "**RUNWAY**",
  // "**APPROACH PROCEDURES**", "**SID**" etc. are categories within that scope.
  var RUNWAY_HEAD = /^\s*\*{3}(\d{1,2}[LRC]?)\*{3}\s*$/;
  // Validity is a date range or "...-UFN"; requiring it keeps wrapped body text
  // from being mistaken for the start of a new NOTAM.
  var NOTAM_HEAD = /^(\w{3})\s+([A-Z]?\d+\/\d{2})\s+((?:\d{6,}|\d{2}[A-Z]{3}\d{6,})\S*(?:-(?:UFN|\S+))?Z?|\S*-UFN)\s*(?:(\d{1,2}[LRC]?)\s*)?$/;
  var CATEGORY_HEAD = /^\s*\*{2,3}([A-Z][A-Z /]*)\*{2,3}\s*$/;

  // "*****KCLT/CLT  --  CHARLOTTE/DOUGLAS INTL*****" then "***GEN***" /
  // "**AIRPORT**" subheads, then remark entries.
  function parseStationRemarks(text) {
    var stations = [], st = null, cat = null, cur = null;
    text.split('\n').forEach(function (l) {
      var s = STATION_HEAD.exec(l);
      if (s) { st = { icao: s[1], iata: s[2], name: s[3].trim(), entries: [] }; stations.push(st); cat = null; cur = null; return; }
      if (!st) return;
      var c = CATEGORY_HEAD.exec(l);
      if (c) { cat = c[1].trim(); cur = null; return; }
      if (isDivider(l) || !l.trim()) { return; }
      var e = /^(\w{3})\s+(N\d+\/\d+)\s+(\S+)\s*$/.exec(l.trim());
      if (e) { cur = { station: e[1], id: e[2], validity: e[3], category: cat, text: '' }; st.entries.push(cur); return; }
      if (cur) cur.text = (cur.text ? cur.text + ' ' : '') + l.trim();
    });
    stations.forEach(function (s) { s.entries.forEach(function (e) { e.text = e.text.trim(); }); });
    return stations;
  }

  /* ---------- HOWGOZIT -------------------------------------------------- */

  function parseHowgozit(t, M) {
    var m = /^\s*(\d{4})Z\s+(\d{4})Z\s+Z\s+(\d*:\d{2})\s+Z\s+(\d{4})Z\s+(\d{4})Z\s*$/m.exec(t);
    if (m) {
      M.times.plannedOutZ = M.times.plannedOutZ || m[1];
      M.times.plannedOffZ = m[2];
      M.eteMin = M.eteMin || hhmm(m[3]);
      M.times.plannedOnZ = m[4];
      M.times.plannedInZ = M.times.plannedInZ || m[5];
    }
    var l = /^\s*(\d{4})L\s+(\d{4})L\s+TZDIF\s+(PLUS|MINUS)\s+([\d.]+)HRS\s+L\s+(\d{4})L\s+(\d{4})L\s*$/m.exec(t);
    if (l) {
      M.times.plannedOutL = M.times.plannedOutL || l[1];
      M.times.plannedOffL = l[2];
      M.times.tzDiffHrs = (l[3] === 'MINUS' ? -1 : 1) * parseFloat(l[4]);
      M.times.plannedOnL = l[5];
      M.times.plannedInL = M.times.plannedInL || l[6];
    }

    // Waypoint rows come in line pairs:
    //  " DCT   N 3511.7  M274        356  :06   :36    1.1"
    //  "LACHN  W08119.8  T267  CLB    19             10.3"
    var lines = t.split('\n');
    for (var i = 0; i < lines.length - 1; i++) {
      var a = lines[i], b = lines[i + 1];
      var ra = /^\s*(\S.*?)\s{2,}N\s*(\d{4}\.\d)\s+M(\d{3})\s+(\S+)?\s*(\d{3})\s+(\d*:\d{2})\s+(\d*:\d{2})\s+([\d.]+)\s*$/.exec(a);
      var rb = /^(\S*)\s+W(\d{5}\.\d)\s+T(\d{3})\s+(\S+)\s+(\d+)\s+([\d.]+)\s*$/.exec(b);
      if (!ra || !rb) continue;
      M.howgozit.push({
        via: ra[1].trim(),
        fix: rb[1] || null,
        lat: ra[2], lon: rb[2],
        magCourse: num(ra[3]), trueCourse: num(rb[3]),
        speed: ra[4] || null,
        groundSpeed: num(ra[5]),
        legTimeMin: hhmm(ra[6]),
        timeRemainingMin: hhmm(ra[7]),
        legFuel: parseFloat(ra[8]),
        phaseOrFL: rb[4],
        legDistNM: num(rb[5]),
        fuelRemaining: parseFloat(rb[6])
      });
    }
    // T-O-C / T-O-D markers
    ['T-O-C', 'T-O-D'].forEach(function (k) {
      var re = new RegExp('^\\*\\s*' + k.replace(/-/g, '-') + '\\s*\\*\\s+N\\s*(\\d{4}\\.\\d)\\s+M(\\d{3})\\s+(\\S+)\\s+(\\d{3})', 'm');
      var mm = re.exec(t);
      if (mm) M.route[k === 'T-O-C' ? 'toc' : 'tod'] = { lat: mm[1], magCourse: num(mm[2]), speed: mm[3] };
    });
  }

  /* ---------- winds ----------------------------------------------------- */

  function parseWinds(t, M) {
    var d = block(t, /^DESCENT FORECAST WINDS\s*$/m, /^\*{10,}/m);
    if (d) {
      var dl = nonEmpty(d.split('\n'));
      if (dl.length >= 2) {
        var alts = dl[0].trim().split(/\s+/);
        var vals = dl[1].trim().split(/\s+/);
        M.winds.descent = alts.map(function (a, i) {
          return { altitude: num(a), raw: vals[i] || null,
                   dir: vals[i] ? num(vals[i].slice(0, 3)) : null,
                   speed: vals[i] ? num(vals[i].slice(3)) : null };
        }).filter(function (x) { return x.raw; });
      }
    }
    var upd = /FORECAST WINDS \*(\d{4})Z\* - NEXT UPDATE AT (\d{4})Z/.exec(t);
    if (upd) M.winds.issuedZ = upd[1], M.winds.nextUpdateZ = upd[2];

    // Enroute table: fix line then SAT/TAT line.
    var er = block(t, /^ENROUTE FORECAST WINDS\s*$/m, /^-{20,}/m);
    if (er) {
      var lines = er.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var m = /^([A-Z]{5})\s+(\d+)\s+(\d{5})\s+(.*)$/.exec(lines[i].trim());
        if (!m) continue;
        M.winds.enroute.push({
          fix: m[1], cruiseFL: num(m[2]), cruiseWind: m[3],
          byLevel: m[4].trim().split(/\s+/)
        });
      }
    }
  }

  /* ---------- NOTAMs ----------------------------------------------------- */

  function parseNotams(t, M) {
    var enroute = block(t, /^\s*WAYPOINT NOTAMS \(COMPANY AND GOVERNMENT\)\s*$/m, /^-{20,}/m);
    if (enroute && /NO ENROUTE NOTAMS FOUND/.test(enroute)) M.notams.enrouteNone = true;

    var gov = block(t, /^\s*GOVERNMENT NOTAMS\s*$/m, null);
    if (!gov) return;

    var st = null, cat = null, rwy = null, cur = null;
    gov.split('\n').forEach(function (l) {
      var s = STATION_HEAD.exec(l);
      if (s) { st = { icao: s[1], iata: s[2], name: s[3].trim(), notams: [] }; M.notams.stations.push(st); cat = null; rwy = null; cur = null; return; }
      var r = RUNWAY_HEAD.exec(l);
      if (r) { rwy = r[1]; cat = null; cur = null; return; }
      var c = CATEGORY_HEAD.exec(l);
      if (c) { cat = c[1].trim(); cur = null; return; }
      if (!st || isDivider(l) || !l.trim()) return;

      // "CLT A8179/26 14AUG260330-04SEP260930Z" starts a NOTAM; runway-scoped
      // entries repeat the runway as a fourth field ("... 01L").
      var h = NOTAM_HEAD.exec(l.trim());
      if (h) {
        cur = { station: h[1], id: h[2], validity: h[3], category: cat, runway: h[4] || rwy, text: '' };
        st.notams.push(cur);
        return;
      }
      if (cur) cur.text = (cur.text ? cur.text + ' ' : '') + l.trim();
    });
    M.notams.stations.forEach(function (s) {
      s.notams.forEach(function (n) { n.text = n.text.trim(); annotateNotam(n); });
    });
  }

  // Wingspan-restricted NOTAMs do not apply to a narrowbody. Flagging them
  // lets the UI collapse them instead of burying the ones that matter.
  function annotateNotam(n) {
    var w = /WINGSPAN\s+(?:MORE THAN|GREATER THAN|EXCEEDING)\s+(\d+)\s*FT/i.exec(n.text);
    if (w) n.wingspanOverFt = num(w[1]);
    n.mentionsRunway = /\bRWY\b/i.test(n.text);
    n.mentionsTaxiway = /\bTWY\b/i.test(n.text);
    n.closed = /\bCLSD\b/i.test(n.text);
  }

  /* ---------- discrepancy report ------------------------------------------ */

  function parseDiscrepancies(t, M) {
    var b = block(t, /^CODE\s+LOC DATE\s+DESCRIPTION\s*$/m, /^END OF REPORT/m);
    if (!b) return;
    var cur = null;
    b.split('\n').forEach(function (l) {
      if (!l.trim()) return;
      // A long MEL code overruns the LOC column and splits the date across it
      // ("M35-11-01B 18   AUG26 ..."), so rejoin before matching.
      l = l.replace(/\b(\d{2})\s+([A-Z]{3}\d{2})\b/, '$1$2');
      var m = /^(\S+)\s+(\S+)?\s*(\d{2}[A-Z]{3}\d{2})\s+(.*)$/.exec(l);
      if (m && /^[A-Z]\d/.test(m[1])) {
        cur = { code: m[1], location: (m[2] || '').trim() || null, date: m[3], description: m[4].trim() };
        M.discrepancies.push(cur);
        return;
      }
      if (cur) cur.description += ' ' + l.trim();
    });
    M.discrepancies.forEach(function (d) { d.description = d.description.replace(/\s+/g, ' ').trim(); });
    var asOf = /FOR SHIP \d+ AS OF (\d{4}) (\w+) ON (\d{2}[A-Z]{3}\d{2})/.exec(t);
    if (asOf) M.discrepanciesAsOf = { time: asOf[1], zone: asOf[2], date: asOf[3] };
  }

  /* ---------- weather ------------------------------------------------------ */

  var WX_HEADS = [
    ['DESTINATION WEATHER', 'destMetars', 'metar'],
    ['DESTINATION FORECAST', 'destTaf', 'taf'],
    ['WEATHER AROUND DESTINATION', 'aroundDest', 'metar'],
    ['ALTERNATE AIRPORT WEATHER', 'alternateWx', 'metar'],
    ['ORIGIN WEATHER', 'originMetars', 'metar'],
    ['ORIGIN FORECAST', 'originTaf', 'taf'],
    ['TAKEOFF ALTERNATE WEATHER', 'takeoffAlternateWx', 'metar'],
    ['DRIFTDOWN ALTERNATE WEATHER', 'driftdownWx', 'metar'],
    ['ENROUTE SURFACE WEATHER', 'enrouteSurface', 'metar']
  ];

  function parseWeather(t, M) {
    var heads = WX_HEADS.map(function (h) { return h[0]; })
      .concat(['TPS-ENROUTE AND UNITED STATES REGIONAL OUTLOOKS', 'TPS-STATION', 'DELTA PIREPS', 'SUBSEQUENT STATIONS', 'FIELD CONDITIONS']);
    var endRe = new RegExp('^\\s*(?:' + heads.map(function (h) {
      return h.replace(/[-/()]/g, '\\$&');
    }).join('|') + ')\\s*$', 'm');

    WX_HEADS.forEach(function (h) {
      var b = block(t, new RegExp('^\\s*' + h[0].replace(/[-/()]/g, '\\$&') + '\\s*$', 'm'), endRe);
      if (b === null) return;
      if (/^\s*(NO REPORT|NO REPORT AVAILABLE)\s*$/m.test(b) && !/METAR|TAF|FM\d/.test(b)) {
        M.wx[h[1]] = [];
        return;
      }
      M.wx[h[1]] = h[2] === 'metar' ? parseMetarBlock(b) : parseTafBlock(b);
    });

    var fc = block(t, /^\s*FIELD CONDITIONS\s*$/m, /^WEATHER BRIEFING .* END/m);
    if (fc) M.wx.fieldConditions = parseFieldConditions(fc);

    var tps = block(t, /^\s*TPS-ENROUTE AND UNITED STATES REGIONAL OUTLOOKS\s*$/m, /^\s*TPS-STATION\s*$/m);
    if (tps) M.wx.tpsOutlooks = parseTps(tps);

    var pireps = block(t, /^\s*DELTA PIREPS\s*$/m, /^\s*SUBSEQUENT STATIONS\s*$/m);
    if (pireps) M.wx.pireps = parsePireps(pireps);

    var hdr = /^DL(\d+)\/(\d{2}) (\w{3})-(\w{3}) SH-(\d+) RLS (\d+)/m.exec(t);
    if (hdr) M.wx.headerRelease = hdr[6];
  }

  // "ATL 181500 METAR 181452Z 31009KT 10SM FEW020 ... " possibly wrapped, and
  // the release prints each observation twice — dedupe on station+body.
  function parseMetarBlock(b) {
    var out = [], cur = null;
    b.split('\n').forEach(function (l) {
      if (!l.trim() || isDivider(l)) return;
      var m = /^(\w{3})\s+(\d{6})\s+(METAR|SPECI)\s+(.*)$/.exec(l.trim());
      if (m) { cur = { station: m[1], fileTime: m[2], type: m[3], raw: m[4].trim() }; out.push(cur); return; }
      if (cur) cur.raw += ' ' + l.trim();
    });
    var seen = {}, dedup = [];
    out.forEach(function (o) {
      o.raw = o.raw.replace(/\s+/g, ' ').trim();
      var k = o.station + '|' + o.raw;
      if (seen[k]) return;
      seen[k] = 1;
      o.decoded = decodeMetar(o.raw);
      dedup.push(o);
    });
    return dedup;
  }

  function parseTafBlock(b) {
    var out = [], cur = null;
    b.split('\n').forEach(function (l) {
      if (!l.trim() || isDivider(l) || /^\s*TERMINAL FORECAST\s*$/.test(l)) return;
      var m = /^(\w{3})\s+(\S+)\s+(\d{6})\s+(.*)$/.exec(l.trim());
      if (m && !/^(FM|RMK|DISCUSSION)/.test(l.trim())) {
        cur = { station: m[1], source: m[2], issued: m[3], header: m[4].trim(), periods: [], remarks: [] };
        out.push(cur);
        return;
      }
      if (!cur) return;
      var s = l.trim();
      if (/^FM\d{6}/.test(s)) cur.periods.push({ raw: s, decoded: decodeMetar(s.replace(/^FM\d{6}\s*/, '')) });
      else if (/^(RMK|DISCUSSION)/.test(s)) cur.remarks.push(s);
      else if (cur.periods.length) cur.periods[cur.periods.length - 1].raw += ' ' + s;
      else cur.header += ' ' + s;
    });
    out.forEach(function (o) {
      var v = /VALID\s+(\d{4})-(\d{4})\s+UTC/.exec(o.header);
      if (v) o.valid = { from: v[1], to: v[2] };
      o.headerDecoded = decodeMetar(o.header.replace(/^.*VALID\s+\d{4}-\d{4}\s+UTC\s*/, ''));
    });
    return out;
  }

  function parseFieldConditions(b) {
    var out = [], cur = null;
    b.split('\n').forEach(function (l) {
      var h = /^(\w{3})\s+UPDATED-(\d{6})/.exec(l.trim());
      if (h) { cur = { station: h[1], updated: h[2], runways: [], surfaces: [], remark: null }; out.push(cur); return; }
      if (!cur) return;
      var s = l.trim();
      var r = /^\*RWY(\S+)\s+(\S+)\s+COVERAGE\s+(\S+)\s+(\S+)(?:\s+RCC\s+(\S+))?\s*RMK-\s*(.*)$/.exec(s);
      if (r) {
        cur.runways.push({
          runway: r[1], condition: r[2], coverage: r[3],
          depth: r[4] === 'N/A' ? null : r[4],
          rcc: r[5] || null,
          remark: (r[6] || '').trim() || null
        });
        return;
      }
      var c = /^\*(TAXIWAY|RAMP) CONDITION CONTAINS\s+(.*?)\s*RMK-(.*)$/.exec(s);
      if (c) { cur.surfaces.push({ area: c[1], condition: c[2].trim(), remark: c[3].trim() }); return; }
      var rm = /^RMK-(.*)$/.exec(s);
      if (rm) cur.remark = rm[1].trim();
    });
    return out;
  }

  function parseTps(b) {
    var out = [], cur = null;
    b.split('\n').forEach(function (l) {
      var h = /^([A-Z]{2}\d{2})\s+(\d{6})-(\d{6})\s*$/.exec(l.trim());
      if (h) { cur = { id: h[1], from: h[2], to: h[3], lines: [] }; out.push(cur); return; }
      if (/^ALERTS NOT AVAILABLE FOR FIX/.test(l.trim())) return;
      if (cur && l.trim()) cur.lines.push(l.trim());
    });
    out.forEach(function (o) {
      var txt = o.lines.join(' ');
      o.hazard = grab(txt, /HAZ:([A-Z-]+(?:\s+[A-Z]+)?)/);
      o.states = grab(txt, /\d\.ON\s+([A-Z ]+?)\s+\d\./) || grab(txt, /\d\.ON\s+([A-Z ]+)/);
      var alts = /ALTS:FL(\d{3})-(\d{3})\s*(\S+)?/.exec(txt);
      if (alts) o.altitudes = { fromFL: num(alts[1]), toFL: num(alts[2]), intensity: alts[3] || null };
      o.advisory = /\*\s*ADVISORY\s*\*/.test(txt);
      o.raw = txt;
    });
    return out;
  }

  // "DAL0342/18 SHIP 3093 POSN33575W083559,HAARY,124314,102,,,,P11,28720,110C466"
  function parsePireps(b) {
    var out = [], cur = null;
    b.split('\n').forEach(function (l) {
      if (!l.trim() || /REPORT INCOMPLETE/.test(l)) return;
      var m = /^(DAL\d+)\/(\d{2})\s+SHIP\s+(\d+)\s+(.*)$/.exec(l.trim());
      if (m) { cur = { flight: m[1], day: m[2], ship: m[3], raw: m[4].trim() }; out.push(cur); return; }
      if (cur) cur.raw += l.trim();
    });
    out.forEach(function (p) {
      var f = p.raw.split(',');
      p.position = f[0] || null;
      p.fix = f[1] || null;
      p.timeUtc = f[2] || null;
      p.flightLevel = f[3] ? num(f[3]) : null;
      var turb = p.raw.match(/,P(\d+),/);
      if (turb) p.rideValue = num(turb[1]);
    });
    return out;
  }

  /* ---------- METAR decoding ------------------------------------------- */

  var CLOUD = { SKC: 'sky clear', CLR: 'clear', FEW: 'few', SCT: 'scattered', BKN: 'broken', OVC: 'overcast', VV: 'vertical visibility' };
  var WX_PHEN = {
    RA: 'rain', SN: 'snow', BR: 'mist', FG: 'fog', HZ: 'haze', TS: 'thunderstorms',
    DZ: 'drizzle', GR: 'hail', GS: 'small hail', PL: 'ice pellets', FZ: 'freezing',
    SH: 'showers', SQ: 'squalls', FU: 'smoke', SA: 'sand', DU: 'dust', VA: 'volcanic ash'
  };

  function decodeMetar(raw) {
    if (!raw) return null;
    var d = { wind: null, visibility: null, weather: [], clouds: [], tempC: null, dewC: null, altimeter: null, ceilingFt: null, flightCategory: null };
    var toks = raw.split(/\s+/);

    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i];
      if (/^RMK$/.test(tk)) break;

      var w = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT$/.exec(tk);
      if (w && !d.wind) {
        d.wind = {
          dir: w[1] === 'VRB' ? 'VRB' : num(w[1]),
          speed: num(w[2]),
          gust: w[3] ? num(w[3]) : null,
          variable: w[1] === 'VRB'
        };
        continue;
      }
      var v = /^(P?)(\d{1,2})(?:\s)?SM$/.exec(tk) || /^(P?)(\d{1,2})SM$/.exec(tk);
      if (v && d.visibility === null) { d.visibility = { sm: num(v[2]), plus: v[1] === 'P' }; continue; }
      var vf = /^(\d)\/(\d)SM$/.exec(tk);
      if (vf && d.visibility === null) { d.visibility = { sm: num(vf[1]) / num(vf[2]), plus: false }; continue; }

      var c = /^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/.exec(tk);
      if (c) {
        var ft = num(c[2]) * 100;
        d.clouds.push({ cover: c[1], baseFt: ft, type: c[3] || null });
        if ((c[1] === 'BKN' || c[1] === 'OVC' || c[1] === 'VV') && (d.ceilingFt === null || ft < d.ceilingFt)) d.ceilingFt = ft;
        continue;
      }
      if (/^(SKC|CLR|NSC|NCD)$/.test(tk)) { d.clouds.push({ cover: tk, baseFt: null }); continue; }

      var t = /^(M?)(\d{2})\/(M?)(\d{2})$/.exec(tk);
      if (t) {
        d.tempC = (t[1] ? -1 : 1) * num(t[2]);
        d.dewC = (t[3] ? -1 : 1) * num(t[4]);
        continue;
      }
      var a = /^A(\d{4})$/.exec(tk);
      if (a) { d.altimeter = num(a[1]) / 100; continue; }
      var q = /^Q(\d{4})$/.exec(tk);
      if (q) { d.altimeterHpa = num(q[1]); continue; }

      var p = /^([-+]?)(VC)?((?:[A-Z]{2}){1,3})$/.exec(tk);
      if (p && p[3] && p[3].length >= 2 && /^(MI|PR|BC|DR|BL|SH|TS|FZ|DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS)/.test(p[3])) {
        var parts = p[3].match(/.{2}/g) || [];
        var words = parts.map(function (x) { return WX_PHEN[x] || x; });
        d.weather.push({
          raw: tk,
          text: (p[1] === '-' ? 'light ' : p[1] === '+' ? 'heavy ' : '') + (p[2] ? 'in the vicinity ' : '') + words.join(' ')
        });
        continue;
      }
    }

    if (d.tempC !== null) d.tempF = Math.round(d.tempC * 9 / 5 + 32);
    if (d.dewC !== null) d.dewF = Math.round(d.dewC * 9 / 5 + 32);
    d.flightCategory = flightCategory(d);
    d.summary = summarizeWx(d);
    return d;
  }

  function flightCategory(d) {
    var vis = d.visibility ? (d.visibility.plus ? 99 : d.visibility.sm) : null;
    var ceil = d.ceilingFt;
    if (vis === null && ceil === null) return null;
    var v = vis === null ? 99 : vis;
    var c = ceil === null ? 99999 : ceil;
    if (v < 1 || c < 500) return 'LIFR';
    if (v < 3 || c < 1000) return 'IFR';
    if (v <= 5 || c <= 3000) return 'MVFR';
    return 'VFR';
  }

  var COMPASS = ['north', 'north-northeast', 'northeast', 'east-northeast', 'east', 'east-southeast', 'southeast', 'south-southeast',
    'south', 'south-southwest', 'southwest', 'west-southwest', 'west', 'west-northwest', 'northwest', 'north-northwest'];
  function compass(deg) { return COMPASS[Math.round(((deg % 360) / 22.5)) % 16]; }

  // Plain-language line for the passenger tab.
  function summarizeWx(d) {
    var bits = [];
    if (d.clouds.length) {
      var sig = d.clouds.filter(function (c) { return c.baseFt !== null; });
      if (!sig.length) bits.push('clear skies');
      else {
        var lowest = sig.reduce(function (a, b) { return b.baseFt < a.baseFt ? b : a; });
        bits.push((CLOUD[lowest.cover] || lowest.cover) + ' clouds at ' + lowest.baseFt.toLocaleString() + ' feet');
      }
    }
    if (d.weather.length) bits.push(d.weather.map(function (w) { return w.text; }).join(', '));
    if (d.visibility && !d.visibility.plus && d.visibility.sm < 6) bits.push('visibility ' + d.visibility.sm + ' miles');
    if (d.wind) {
      if (d.wind.speed === 0) bits.push('wind calm');
      else if (d.wind.variable) bits.push('light variable wind');
      else bits.push('wind from the ' + compass(d.wind.dir) + ' at ' + d.wind.speed + ' knots' + (d.wind.gust ? ', gusting ' + d.wind.gust : ''));
    }
    if (d.tempC !== null) bits.push(d.tempC + '°C / ' + d.tempF + '°F');
    return bits.join(', ');
  }

  /* ---------- addendum / crew / status ------------------------------------ */

  function parseAddendum(t, M) {
    var re = /^(CAPTAIN|FIRST OFFICER)\s+ROTATION ID\s+(\w+)\s+(\d+)/gm, m;
    while ((m = re.exec(t))) {
      M.dutyLimits.push({ role: m[1], base: m[2], rotationId: m[3] });
    }
    var l1 = /DUTY LATT DUE MAX FDP LIMIT:\s+(\d{2})\/(\d{4})Z/.exec(t);
    if (l1) M.times.latestTakeoff = { day: l1[1], timeZ: l1[2] };
    var l2 = /DUTY LATT DUE MAX FDP LIMIT WITH EXTENSION APPLIED:\s*(\d{2})\/(\d{4})Z/.exec(t);
    if (l2) M.times.latestTakeoffExtended = { day: l2[1], timeZ: l2[2] };

    var cfg = /^PSGR CONFIG\s+(\d+)\/(\d+)\s*$/m.exec(t);
    if (cfg) M.paxConfig = { first: num(cfg[1]), main: num(cfg[2]), total: num(cfg[1]) + num(cfg[2]) };

    var mn = block(t, /^MEL NOTES:\s*$/m, /^-{20,}/m);
    if (mn) {
      var cur = null;
      mn.split('\n').forEach(function (l) {
        var s = l.trim();
        if (!s) return;
        if (/^[A-Z]?\d{2}-\d{2}-\d{2}/.test(s)) { cur = { code: s, description: '', procedure: '' }; M.melNotes.push(cur); return; }
        if (!cur) return;
        var p = /^FLT OPS PROC:\s*(.*)$/.exec(s);
        if (p) { cur.procedure = p[1].trim(); return; }
        if (cur.procedure) cur.procedure += ' ' + s;
        else cur.description += (cur.description ? ' ' : '') + s;
      });
      // attach procedures to the matching MEL item
      M.melNotes.forEach(function (n) {
        M.mel.forEach(function (item) {
          if (item.code === n.code) item.procedure = n.procedure || null;
        });
      });
    }
  }

  function parseCrew(t, M) {
    var re = /^\s*(PLT|F\/A)\s+([A-Z])\s+(\d+)\s+(.+?)\s*$/gm, m;
    while ((m = re.exec(t))) {
      M.crew.push({
        role: m[1] === 'PLT' ? 'Pilot' : 'Flight Attendant',
        position: m[2],
        employeeId: m[3],
        name: m[4].replace(/-+$/, '').trim()
      });
    }
    var rot = /^\s*(\d[A-Z])\/(\w{3})\/(\d+)\|(\d{2}[A-Z]{3})/gm;
    while ((m = rot.exec(t))) M.rotations.push({ code: m[1], base: m[2], id: m[3], effective: m[4] });
  }

  function parseBriefingGuide(t, M) {
    function list(startRe, endRe) {
      var b = block(t, startRe, endRe);
      if (!b) return [];
      var items = [];
      b.split('\n').forEach(function (l) {
        var re = /(\d{1,2})\.\s+([A-Z][^0-9]*?)(?=\s{2,}\d{1,2}\.|\s*$)/g, m;
        while ((m = re.exec(l))) items.push({ n: num(m[1]), text: m[2].trim() });
      });
      return items.sort(function (a, b2) { return a.n - b2.n; });
    }
    M.cabinBriefing.all = list(/^ALL FLIGHTS:\s*$/m, /^FIRST FLIGHT OF THE DAY/m);
    M.cabinBriefing.firstFlight = list(/^FIRST FLIGHT OF THE DAY\/AFTER CREW CHANGE\s*$/m, /^-{20,}/m);
    M.cabinBriefing.descent = list(/^DESCENT BRIEFING\s*$/m, /^-{20,}/m);
  }

  function parseOpsAlerts(t, M) {
    if (/NO ALERT MESSAGES AVAILABLE/.test(t)) { M.opsAlerts = []; return; }
    var b = block(t, /\/\/-+\/\/\s*$/m, /\/\/-+\/\//m);
    if (!b) return;
    b.split('\n').forEach(function (l) {
      var s = l.replace(/^\/\/\s?/, '').replace(/\s*\/\/\s*$/, '').trim();
      if (s && !/^-+$/.test(s)) M.opsAlerts.push(s);
    });
  }

  /* ---------- FD Pro deep link (route cross-check) ------------------------- */

  function parseRouteLink(url, M) {
    if (!url) return;
    try {
      var q = {};
      String(url).split(/[?&]/).slice(1).forEach(function (kv) {
        var i = kv.indexOf('=');
        if (i > 0) q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
      });
      M.routeLink = {
        origin: q.pod || null, dest: q.poa || null,
        route: q.rte || null, planId: q.plan_id || null,
        registration: q.reg || null, alternate: q.alt || null
      };
    } catch (e) { /* link is a nice-to-have cross-check, never fatal */ }
  }

  /* ---------- derived values ----------------------------------------------- */

  function derive(M) {
    var D = M.derived;

    if (M.eteMin !== null) D.eteText = fmtDur(M.eteMin);
    if (M.times.plannedOutZ && M.times.plannedInZ) {
      D.blockMin = diffZ(M.times.plannedOutZ, M.times.plannedInZ);
      D.blockText = fmtDur(D.blockMin);
    }
    if (M.fuel.block !== null && M.fuel.minTakeoff !== null) {
      D.fuelOverMinimum = M.fuel.block - M.fuel.minTakeoff;
    }
    if (M.fuel.plannedLandingFuel !== null && M.fuel.minimumLandingFuel !== null) {
      D.landingFuelMargin = M.fuel.plannedLandingFuel - M.fuel.minimumLandingFuel;
    }

    // Runways the field-conditions report lists are the ones in use.
    D.originRunways = [];
    D.destRunways = [];
    (M.wx.fieldConditions || []).forEach(function (fc) {
      var target = fc.station === M.origin.iata ? D.originRunways
        : fc.station === M.dest.iata ? D.destRunways : null;
      if (!target) return;
      fc.runways.forEach(function (r) {
        var id = r.runway.split('-')[0];        // "26L-E13" -> "26L"
        if (target.indexOf(id) < 0) target.push(id);
      });
    });

    D.latestOriginMetar = latest(M.wx.originMetars);
    D.latestDestMetar = latest(M.wx.destMetars);

    // Only the TPS advisories that could touch this flight's levels.
    D.relevantTps = (M.wx.tpsOutlooks || []).filter(function (o) {
      if (!o.altitudes || M.cruiseFL === null) return true;
      return M.cruiseFL >= o.altitudes.fromFL && M.cruiseFL <= o.altitudes.toFL;
    });
    D.filteredTpsCount = (M.wx.tpsOutlooks || []).length - D.relevantTps.length;

    // PIREPs on a fix we actually cross.
    var fixes = (M.route.fixList || []).concat((M.howgozit || []).map(function (h) { return h.fix; }));
    D.onRoutePireps = (M.wx.pireps || []).filter(function (p) {
      return p.fix && fixes.indexOf(p.fix) >= 0;
    });

    D.melCount = M.mel.length;
    D.openDiscrepancies = M.discrepancies.length;
    return D;
  }

  function latest(list) {
    if (!list || !list.length) return null;
    return list[list.length - 1];
  }
  function diffZ(a, b) {
    var am = num(a.slice(0, 2)) * 60 + num(a.slice(2));
    var bm = num(b.slice(0, 2)) * 60 + num(b.slice(2));
    var d = bm - am;
    if (d < 0) d += 24 * 60;
    return d;
  }

  /* ---------- wind components ---------------------------------------------- */

  // runway "01L" -> 010 magnetic. Component maths uses the METAR wind, which is
  // magnetic for US surface reports, so no variation correction is applied.
  function runwayHeading(rwy) {
    var m = /^(\d{1,2})/.exec(String(rwy || ''));
    if (!m) return null;
    return num(m[1]) * 10;
  }
  function windComponents(rwy, wind) {
    var hdg = runwayHeading(rwy);
    if (hdg === null || !wind || wind.dir === 'VRB' || wind.dir === null) return null;
    var angle = (wind.dir - hdg) * Math.PI / 180;
    var head = wind.speed * Math.cos(angle);
    var cross = wind.speed * Math.sin(angle);
    var gustHead = wind.gust ? wind.gust * Math.cos(angle) : null;
    var gustCross = wind.gust ? wind.gust * Math.sin(angle) : null;
    return {
      runway: rwy,
      runwayHeading: hdg,
      headwind: Math.round(head),
      tailwind: head < 0 ? Math.abs(Math.round(head)) : 0,
      crosswind: Math.round(Math.abs(cross)),
      crosswindFrom: cross >= 0 ? 'right' : 'left',
      gustCrosswind: gustCross === null ? null : Math.round(Math.abs(gustCross)),
      gustHeadwind: gustHead === null ? null : Math.round(gustHead)
    };
  }

  /* ---------- entry point --------------------------------------------------- */

  function emptyModel() {
    return {
      profile: null, confidence: 0,
      carrier: null, flightNo: null, dateDDMMM: null, shipNo: null, release: null, opsType: null,
      acType: null, wakeCat: null, equipment: null, surveillance: null, registration: null,
      selcal: null, pbn: null, transponderCode: null, perfCat: null,
      atcCallsign: null, acarsId: null, gate: null, costIndex: null,
      cruiseFL: null, tocWind: null, isaDev: null, distanceNM: null, tas: null, eteMin: null,
      dispatcher: null, dispatchDesk: null, dispatchPhone: null,
      origin: { iata: null, icao: null, name: null, elevation: null },
      dest: { iata: null, icao: null, name: null, elevation: null },
      destAlternates: [],
      route: { raw: null, tokens: [], sid: null, star: null, fixList: [], toc: null, tod: null },
      routeLink: null,
      times: {}, weights: {}, fuel: {},
      paxConfig: null,
      mel: [], melNotes: [], discrepancies: [], discrepanciesAsOf: null,
      remarks: { dispatcher: [], flightOpsMaint: [], cityPair: [], airport: [], alternateAirport: [] },
      opsAlerts: [],
      howgozit: [],
      winds: { enroute: [], descent: [], issuedZ: null, nextUpdateZ: null },
      notams: { stations: [], enrouteNone: false },
      wx: {
        destMetars: [], destTaf: [], aroundDest: [], alternateWx: [], originMetars: [], originTaf: [],
        takeoffAlternateWx: [], driftdownWx: [], enrouteSurface: [],
        fieldConditions: [], tpsOutlooks: [], pireps: []
      },
      crew: [], rotations: [], dutyLimits: [], cabinBriefing: {},
      derived: {},
      warnings: []
    };
  }

  function parseRelease(pages, opts) {
    opts = opts || {};
    var norm = pages.map(normalizeText);
    var S = splitSections(norm);
    var M = emptyModel();

    var all = norm.join('\n');
    M.profile = /prepared by iCrew Mobile/i.test(all) ? 'icrew-mobile' : 'unknown';

    try { parseCaptainCopy(S['Flight Dispatch Captain Copy'] || '', M); }
    catch (e) { M.warnings.push('captain copy: ' + e.message); }
    try { parseRemarks(S['Remarks'] || '', M); }
    catch (e) { M.warnings.push('remarks: ' + e.message); }
    try { parseOpsAlerts(S['Flight Ops Alerts'] || '', M); }
    catch (e) { M.warnings.push('ops alerts: ' + e.message); }
    try { parseHowgozit(S['HOWGOZIT'] || '', M); }
    catch (e) { M.warnings.push('howgozit: ' + e.message); }
    try { parseWinds(S['Enroute Forecast Winds'] || '', M); }
    catch (e) { M.warnings.push('winds: ' + e.message); }
    try { parseNotams(S['NOTAMS'] || '', M); }
    catch (e) { M.warnings.push('notams: ' + e.message); }
    try { parseDiscrepancies(S['Aircraft Discrepancy Report'] || '', M); }
    catch (e) { M.warnings.push('discrepancies: ' + e.message); }
    try { parseWeather(S['Weather Briefing'] || '', M); }
    catch (e) { M.warnings.push('weather: ' + e.message); }
    try { parseCrew(S['Crew Member List'] || '', M); }
    catch (e) { M.warnings.push('crew: ' + e.message); }
    try { parseAddendum(S['Flight Plan Addendum'] || '', M); }
    catch (e) { M.warnings.push('addendum: ' + e.message); }
    try { parseBriefingGuide(S['Captain/Flight Attendant Briefing Guide'] || '', M); }
    catch (e) { M.warnings.push('briefing guide: ' + e.message); }
    try { parseRouteLink(opts.routeLink, M); }
    catch (e) { /* non-fatal */ }

    derive(M);
    crossCheck(M);
    M.confidence = scoreConfidence(M);
    M.sections = S.__order;
    return M;
  }

  // The FD Pro deep link on the last page repeats origin/dest/route/reg. If the
  // text parse disagrees, say so rather than silently trusting either one.
  function crossCheck(M) {
    var L = M.routeLink;
    if (!L) return;
    if (L.origin && M.origin.icao && L.origin !== M.origin.icao) {
      M.warnings.push('origin mismatch: text ' + M.origin.icao + ' vs route link ' + L.origin);
    }
    if (L.dest && M.dest.icao && L.dest !== M.dest.icao) {
      M.warnings.push('destination mismatch: text ' + M.dest.icao + ' vs route link ' + L.dest);
    }
    if (L.registration && M.registration && L.registration !== M.registration) {
      M.warnings.push('registration mismatch: text ' + M.registration + ' vs route link ' + L.registration);
    }
    if (L.route && M.route.raw) {
      var linkTokens = L.route.split(/[+\s]+/).filter(Boolean);
      var missing = linkTokens.filter(function (tk) { return M.route.raw.indexOf(tk) < 0; });
      if (missing.length) M.warnings.push('route link has tokens not in filed route: ' + missing.join(' '));
    }
  }

  var KEY_FIELDS = [
    function (M) { return M.flightNo; }, function (M) { return M.origin.icao; },
    function (M) { return M.dest.icao; }, function (M) { return M.route.raw; },
    function (M) { return M.eteMin; }, function (M) { return M.cruiseFL; },
    function (M) { return M.fuel.block; }, function (M) { return M.weights.tow; },
    function (M) { return M.wx.destMetars.length ? 1 : null; },
    function (M) { return M.wx.originMetars.length ? 1 : null; }
  ];
  function scoreConfidence(M) {
    var got = KEY_FIELDS.filter(function (f) {
      var v = f(M);
      return v !== null && v !== undefined && v !== '';
    }).length;
    return Math.round((got / KEY_FIELDS.length) * 100) / 100;
  }

  var API = {
    normalizeText: normalizeText,
    splitSections: splitSections,
    parseRelease: parseRelease,
    decodeMetar: decodeMetar,
    windComponents: windComponents,
    runwayHeading: runwayHeading,
    fmtDur: fmtDur,
    compass: compass,
    SECTIONS: SECTIONS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.VFB_PARSE = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
