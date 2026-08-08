import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '../shared/edst-sigmets.js'), 'utf8');
const sandbox = { window: {}, globalThis: {}, console };
vm.runInNewContext(src, sandbox, { filename: 'edst-sigmets.js' });
const EdstSigmets = sandbox.window.EdstSigmets || sandbox.globalThis.EdstSigmets;
if (!EdstSigmets) throw new Error('EdstSigmets not loaded');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const convectiveRaw = [
  'WSUS32 KKCI 081155',
  'SIGC ',
  'CONVECTIVE SIGMET 53C',
  'VALID UNTIL 1355Z',
  'LA AND FL AL MS LA CSTL WTRS',
  'FROM 30WSW LCH-90SSW CEW-140SE LEV-80SSW LCH-30WSW LCH',
  'AREA TS MOV LTL. TOPS ABV FL450.',
  'REF INTL SIGMET FOXTROT SERIES.',
  '',
  'OUTLOOK VALID 081355-081755',
  'AREA 1...FROM 40ENE FAM-130ESE LEV-130SSW LCH-70E',
  'BRO-BRO-RZC-40ENE FAM',
  'WST ISSUANCES EXPD. REFER TO MOST RECENT ACUS01 KWNS FROM STORM',
  'PREDICTION CENTER FOR SYNOPSIS AND METEOROLOGICAL DETAILS.',
].join('\n');

{
  const para = EdstSigmets.firstParagraph(convectiveRaw);
  assert(para.includes('CONVECTIVE SIGMET 53C'), 'keeps SIGMET body');
  assert(para.includes('TOPS ABV FL450'), 'keeps tops line');
  assert(!para.includes('OUTLOOK'), 'drops OUTLOOK section');
  assert(!para.includes('WST ISSUANCES'), 'drops outlook narrative');
}

{
  const intl = [
    'WSCV31 GVAC 070910',
    'GVSC SIGMET 2 VALID 070910/091310 GVAC- ',
    'GVSC SAL OCEANIC FIR/UIR EMBD TS OBS AT 0845Z ',
    'WI N1326 W02106 - N1431 W02147',
    'TOP ABV FL350 MOV W 17KT NC=',
  ].join('\n');
  const para = EdstSigmets.firstParagraph(intl);
  assert(para.includes('EMBD TS'), 'intl first paragraph kept');
  assert(para.includes('NC='), 'keeps end marker when single paragraph');
}

{
  const entry = EdstSigmets._fromAirsigmet(
    { seriesId: '53C', hazard: 'CONVECTIVE', rawAirSigmet: convectiveRaw },
    'KZJX'
  );
  assert(entry.text.includes('CONVECTIVE SIGMET 53C'));
  assert(!entry.text.includes('OUTLOOK'));
}

{
  const built = EdstSigmets._buildTextFromNws(
    { fir: 'KZJX', sequence: '53C', hazard: 'convective' },
    { _rawText: convectiveRaw }
  );
  assert(built.includes('AREA TS MOV LTL'));
  assert(!built.includes('OUTLOOK VALID'));
}

{
  assert(EdstSigmets.firstParagraph('') === '');
  assert(EdstSigmets.firstParagraph('  LINE ONE  \n\nLINE TWO') === 'LINE ONE');
}

console.log('test-edst-sigmet-first-para: ok');
