import { describe, it, expect } from "vitest";
import { pageJs } from "../src/console/page.js";

// Run the real browser helpers without a DOM or network. Guards both disclosure scope and copy.
function helpers() {
  const start=pageJs.indexOf('function redactEvidenceDetail(');
  const end=pageJs.indexOf('function render()');
  const state:any={live:false,snapshotAt:'2026-11-15T01:00:00Z',snapshotStale:false,audit:[
    {seq:1,caseId:'other',detail:{private:'other-case-value'}},
    {seq:2,kind:'global',detail:{private:'global-value'}},
    {seq:3,caseId:'case-a',kind:'approval_issued',detail:{termsHash:'fullhash',note:'long'.repeat(100)}},
  ]};
  const esc=(s:unknown)=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]!));
  const funcs=new Function('state','esc',pageJs.slice(start,end)+';return {caseEvidence,evidencePanel};')(state,esc);
  const c:any={kase:{id:'case-a',vendor:'Acme'},decision:{cadence:'annual'},intent:{id:'i',termsHash:'terms',cadence:'annual',amountCap:480,currency:'USD',categories:['software']},intentHash:'intent',transactions:[],ledger:{state:'ok'},cardStatusRead:{state:'ok'},approval:{signature:'DO-NOT-EXPORT'},contractSource:{id:'sf',version:'v1',privateToken:'DO-NOT-EXPORT'}};
  return {...funcs,state,c};
}

describe('read-only case evidence',()=>{
  it('re-renders stale warnings after a failed refresh, not only in exported JSON',()=>{
    expect(pageJs).toContain('state.snapshotStale = true; render();');
  });
  it('exports only selected-case events, keeping full detail and order',()=>{
    const h=helpers(),e=h.caseEvidence(h.c);
    expect(e.events.map((a:any)=>a.seq)).toEqual([3]);
    expect(e.events[0].detail.note.length).toBe(400);
    expect(JSON.stringify(e)).not.toMatch(/other-case-value|global-value|DO-NOT-EXPORT/);
  });
  it('redacts nested approval nonces and credential-shaped keys without mutating audit',()=>{
    const h=helpers();h.state.audit=[{seq:1,caseId:'case-a',detail:{nonce:'hidden-nonce',nested:{signature:'hidden-sig',token:'hidden-token'},amountCap:480}}];
    const e=h.caseEvidence(h.c);expect(JSON.stringify(e)).not.toMatch(/hidden-nonce|hidden-sig|hidden-token/);expect(e.events[0].detail.amountCap).toBe(480);expect(h.state.audit[0].detail.nonce).toBe('hidden-nonce');
  });
  it('preserves mode, exact hashes, source version, and refresh timestamp without claiming finality',()=>{
    const h=helpers(),e=h.caseEvidence(h.c);
    expect(e.evidenceMode).toContain('Local simulator');
    expect(e.approvedIntent).toMatchObject({termsHash:'terms',intentHash:'intent'});
    expect(e.source).toEqual({id:'sf',version:'v1',invalidated:false});
    expect(e.snapshotAt).toBe(h.state.snapshotAt);
    expect(e.limits.join(' ')).toContain('not a signed provider attestation');
    expect(e.limits.join(' ')).toContain('cannot independently verify');
  });
  it('renders unresolved, stale, rejected and unverifiable outcomes as warnings',()=>{
    const h=helpers();h.state.snapshotStale=true;
    Object.assign(h.c,{rejected:true,sourceInvalidated:true,requiresReapproval:true,freezeState:'unknown',createCardUnresolved:{},pendingAuthorization:{},cardStatusRead:{state:'unavailable'},ledger:{state:'degraded'}});
    const html=h.evidencePanel(h.c);
    for(const x of ['Snapshot refresh failed','Rejected','previous approval must not be reused','spending locked','Freeze unverified','not current evidence','not proof of no transactions']) expect(html).toContain(x);
  });
  it('escapes hostile event text and labels unavailable audit without inventing events',()=>{
    const h=helpers();h.state.audit=[{seq:1,caseId:'case-a',detail:{note:'<img src=x onerror=alert(1)>'}}];
    expect(h.evidencePanel(h.c)).toContain('&lt;img');expect(h.evidencePanel(h.c)).not.toContain('<img');
    h.state.audit=[];
    expect(h.evidencePanel(h.c)).toContain('0 visible to this session');
    expect(h.evidencePanel(h.c)).toContain('not that nothing happened');
  });
  it('handles pre-approval cases without adding approval authority',()=>{
    const h=helpers();h.c.intent=undefined;h.c.contractSource=undefined;
    const e=h.caseEvidence(h.c);expect(e.approvedIntent).toBeNull();expect(e.source).toBeNull();
    expect(h.evidencePanel(h.c)).toContain('No approved intent');
    expect(h.evidencePanel(h.c)).toContain('opening or downloading this view makes no approval');
  });
});
