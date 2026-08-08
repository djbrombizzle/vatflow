import{
  csFromWho,
  filterCpdlcLog,
  cpdlcLogTitle,
  cpdlcLogEmptyText,
}from'../shared/cpdlc-log-filter.js';

function assert(cond,msg){
  if(!cond)throw new Error(msg||'assertion failed');
}

const sample=[
  {kind:'out',who:'AAL123',text:'CLIMB TO FL350'},
  {kind:'in',who:'AAL123',text:'WILCO'},
  {kind:'out',who:'UAL456',text:'PROCEED DIRECT JAYBJ'},
  {kind:'out',who:'AAL123 · co-ctrl',text:'CONTACT ZNY_36 133.45'},
  {kind:'sys',who:'AAL123',text:'logon auto-accepted'},
  {kind:'out',who:'ZJX_CTR → DAL789',text:'DESCEND TO FL240'},
  {kind:'in',who:'DAL789',text:'ROGER'},
];

assert(csFromWho('AAL123 · co-ctrl')==='AAL123','strip co-ctrl');
assert(csFromWho('ZJX_CTR → DAL789')==='DAL789','arrow to aircraft');

{
  const r=filterCpdlcLog(sample,'all','AAL123');
  assert(!r.needsSelection,'all ignores selection need');
  assert(r.entries.length===sample.length,'all returns full log');
}

{
  const r=filterCpdlcLog(sample,'hist','AAL123');
  assert(!r.needsSelection);
  assert(r.cs==='AAL123');
  assert(r.entries.length===4,'hist includes in/out/sys/co-ctrl for CS');
  assert(r.entries.every(e=>csFromWho(e.who)==='AAL123'));
}

{
  const r=filterCpdlcLog(sample,'msgout','AAL123');
  assert(r.entries.length===2,'msgout only uplinks');
  assert(r.entries.every(e=>e.kind==='out'));
}

{
  const r=filterCpdlcLog(sample,'hist',null);
  assert(r.needsSelection);
  assert(r.entries.length===0);
  assert(cpdlcLogEmptyText('hist',true).includes('Select'));
}

{
  assert(cpdlcLogTitle('hist','AAL123')==='CPDLC HIST — AAL123');
  assert(cpdlcLogTitle('msgout','AAL123')==='CPDLC MSGOUT — AAL123');
  assert(cpdlcLogTitle('all')==='CPDLC ALL');
  assert(cpdlcLogEmptyText('all',false)==='No datalink messages');
  assert(cpdlcLogEmptyText('msgout',false).includes('uplink'));
}

console.log('test-cpdlc-log-filter: ok');
