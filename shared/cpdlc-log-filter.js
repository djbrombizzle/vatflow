/**
 * CPDLC toolbar log modes (EDST):
 * - hist   → all messages for the highlighted aircraft
 * - msgout → controller uplinks (kind=out) for the highlighted aircraft
 * - all    → full datalink log (uplink + downlink), selection ignored
 */

export function csFromWho(who){
  let w=String(who||'').split('\u00b7')[0].trim(); // strip " · co-ctrl"
  if(w.includes('\u2192'))w=w.split('\u2192')[1].trim(); // "FRM → TO" → aircraft
  return w.toUpperCase();
}

/**
 * @param {Array<{kind?:string,who?:string,text?:string,time?:string}>} log
 * @param {'hist'|'msgout'|'all'} mode
 * @param {string|null|undefined} selectedCs
 * @returns {{entries: typeof log, needsSelection: boolean, cs: string}}
 */
export function filterCpdlcLog(log,mode,selectedCs){
  const m=String(mode||'all').toLowerCase();
  const list=Array.isArray(log)?log:[];
  if(m==='all'){
    return{entries:list.slice(),needsSelection:false,cs:''};
  }
  const cs=String(selectedCs||'').trim().toUpperCase();
  if(!cs){
    return{entries:[],needsSelection:true,cs:''};
  }
  let entries=list.filter(e=>csFromWho(e&&e.who)===cs);
  if(m==='msgout')entries=entries.filter(e=>(e&&e.kind)==='out');
  return{entries,needsSelection:false,cs};
}

export function cpdlcLogTitle(mode,cs){
  const m=String(mode||'all').toLowerCase();
  if(m==='hist')return cs?('CPDLC HIST — '+cs):'CPDLC HIST';
  if(m==='msgout')return cs?('CPDLC MSGOUT — '+cs):'CPDLC MSGOUT';
  return'CPDLC ALL';
}

export function cpdlcLogEmptyText(mode,needsSelection){
  const m=String(mode||'all').toLowerCase();
  if(needsSelection){
    if(m==='msgout')return'Select an aircraft on the ACL to view MSGOUT';
    return'Select an aircraft on the ACL to view CPDLC HIST';
  }
  if(m==='msgout')return'No uplink messages for this aircraft';
  if(m==='hist')return'No CPDLC history for this aircraft';
  return'No datalink messages';
}
