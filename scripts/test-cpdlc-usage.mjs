import {
  canViewCpdlcStats, fetchCpdlcStats, fillDaily, pct, renderCpdlcStats,
} from '../shared/cpdlc-usage.js';

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

assert(canViewCpdlcStats({ cid: '816206' }), 'owner sees card');
assert(canViewCpdlcStats({ cid: 816206 }), 'numeric cid ok');
assert(!canViewCpdlcStats({ cid: '1234567', isAdmin: true }), 'other admin hidden');
assert(!canViewCpdlcStats(null), 'signed out hidden');

assert(pct(1, 4) === '25%' && pct(1, 0) === '—', 'pct');

const filled = fillDaily([{ day: '2026-11-02', controllersOpened: 2, controllersSignedIn: 1, pilots: 5 }],
  '2026-11-01', '2026-11-03');
assert(filled.length === 3, 'fills range');
assert(filled[0].pilots === 0 && filled[1].pilots === 5, 'keeps data, zeros gaps');

let sent;
const res = await fetchCpdlcStats('jwt', 90, {
  base: 'https://hub.test',
  fetchFn: async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return { ok: false, status: 403, json: async () => ({ ok: false, error: 'not allowed' }) }; },
});
assert(sent.url === 'https://hub.test/hub/stats', 'url');
assert(sent.body.vatflowToken === 'jwt' && sent.body.days === 90 && sent.body.list === true, 'body');
assert(res.ok === false && /not allowed/.test(renderCpdlcStats(res)), 'error rendered');

assert(/No CPDLC activity/.test(renderCpdlcStats({ ok: true, trackingSince: null })), 'empty state');

const html = renderCpdlcStats({
  ok: true, trackingSince: '2026-11-01', range: { days: 90, from: '2026-11-01', to: '2026-11-02' },
  controllers: { opened: 4, signedIn: 2, signInSessions: 3 }, pilots: { unique: 9, logons: 12 },
  byArtcc: { KZJX: { controllers: 1, pilots: 7 } },
  daily: [{ day: '2026-11-01', controllersOpened: 4, controllersSignedIn: 2, pilots: 9 }],
  controllerList: [{ cid: '1', signedIn: true, signIns: 3, days: 1, callsigns: ['ZJX_23_CTR<'] }],
  pilotList: [{ id: 'cs:AAL1', logons: 1, days: 1, callsigns: ['AAL1'] }],
});
assert(html.includes('50% went on to sign in'), 'conversion');
assert(html.includes('4.5'), 'pilots per controller');
assert(html.includes('ZJX_23_CTR&lt;') && !html.includes('ZJX_23_CTR<'), 'escaped');
assert(html.includes('unknown'), 'callsign-only pilot');
console.log('cpdlc-usage tests passed');
