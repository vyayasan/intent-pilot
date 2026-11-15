import { readFileSync } from "node:fs";
const interFont = readFileSync(new URL("./fonts/Inter.ttf", import.meta.url)).toString("base64");
const monoFont = readFileSync(new URL("./fonts/JetBrainsMono.ttf", import.meta.url)).toString("base64");

export const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IntentPay - Approval console</title>
<link rel="stylesheet" href="/console.css"></head><body>
<div class="strip">IntentPay console · __GATEWAY_MODE__</div>
<div class="wrap">
  <aside class="side">
    <div class="org"><span class="orgmark">IP</span><div class="orgt"><strong>IntentPay</strong><span>Intent-bound purchase agent</span></div></div>
    <p class="navhead">Issuing</p>
    <div class="navitem active">Purchase intents</div>
    <div class="qrow"><p class="navhead">Queue</p><span><button class="act sec" id="newcase" style="padding:5px 10px;font-size:11px">New case</button> <button class="act sec" id="reset" style="padding:5px 10px;font-size:11px">Reset demo</button></span></div>
    <button class="act sec" id="refresh" style="margin:12px 0;padding:6px 10px;font-size:11px">Refresh provider reads</button><div id="readhealth" style="font-size:11px;color:#fdb022" role="status">Loading current reads...</div>
    <div id="cases"></div>
    <div class="sidefoot">__GATEWAY_FOOTER__</div>
  </aside>
  <main class="content"><div id="panel"></div></main>
</div>
<div class="toast" id="toast"></div>
<script src="/console.js"></script></body></html>`;

export const pageCss = `
@font-face{font-family:Inter;src:url(data:font/ttf;base64,${interFont}) format("truetype");font-weight:100 900;font-style:normal;font-display:swap}
@font-face{font-family:"JetBrains Mono";src:url(data:font/ttf;base64,${monoFont}) format("truetype");font-weight:100 800;font-style:normal;font-display:swap}
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#173B32;background:#F6F4EC;font-synthesis:none;--ink:#173B32;--muted:#65736A;--rule:#DCE2D8;--sage:#E7EEE2;--coral:#B94F36;--pale:#FFF0E9}
*{box-sizing:border-box}body{margin:0;font-size:15px;line-height:1.55}button,input,textarea{font:inherit}button{touch-action:manipulation}
.strip{background:#173B32;color:#fff;font-size:12px;letter-spacing:.035em;text-align:center;padding:10px 18px}
.wrap{display:grid;grid-template-columns:280px minmax(0,1fr);min-height:calc(100vh - 39px);align-items:start;max-width:1800px;margin:auto}
.side{background:#EEEFE8;color:var(--ink);display:flex;flex-direction:column;padding:30px 20px;position:sticky;top:0;min-height:calc(100vh - 39px);border-right:1px solid var(--rule)}
.org{display:flex;gap:12px;align-items:center;padding:0 6px 26px;border-bottom:1px solid var(--rule);margin-bottom:8px}.orgmark{width:38px;height:38px;border-radius:10px;background:var(--ink);color:#fff;display:grid;place-items:center;font-weight:700;font-size:17px;flex-shrink:0}.orgt strong{font-size:23px;letter-spacing:-.045em;display:block;font-weight:700}.orgt span{font-size:12px;color:var(--muted)}
.navhead{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.09em;color:var(--muted);margin:20px 8px 8px;text-transform:uppercase;font-weight:500}.navitem{padding:12px 14px;border-radius:10px;font-size:15px}.navitem.active{color:var(--ink);background:var(--sage);font-weight:650;box-shadow:inset 3px 0 var(--ink)}
.casebtn{display:block;width:100%;text-align:left;background:transparent;border:1px solid transparent;padding:14px 12px;margin:5px 0;border-radius:12px;cursor:pointer;color:var(--ink);font:inherit;overflow-wrap:anywhere}.casebtn:hover{background:#f7f8f3}.casebtn.on{background:#fff;border-color:var(--rule);box-shadow:0 3px 12px #173b3206}.casebtn b{font-size:14px;font-weight:650;display:block}.casebtn span{color:var(--muted);font-size:12px;text-transform:capitalize}.casebtn.on span{color:var(--coral)}
.sidefoot{margin-top:auto;padding:28px 8px 0;color:var(--muted);font-size:12px}.sidefoot:after{content:'Vyaya.';display:block;color:var(--ink);font-size:23px;letter-spacing:-.04em;font-weight:700;margin-top:24px}.qrow{display:flex;justify-content:space-between;align-items:center;margin-top:20px;gap:6px}.qrow .navhead{margin:0 8px}.qrow>span{display:flex;gap:5px}
.content{padding:40px 42px 80px;min-width:0}.muted{font-size:13px;color:var(--muted);overflow-wrap:anywhere}.panelhead{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:26px}.panelhead h2{margin:0;font-size:30px;font-weight:650;letter-spacing:-.045em;line-height:1.2}.panelhead .muted{font-family:'JetBrains Mono',monospace;font-size:10px;max-width:40%;text-align:right}
.grid2{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:20px}.box{background:#fff;border:1px solid var(--rule);border-radius:18px;padding:26px;box-shadow:0 5px 22px #173b3203;min-width:0}.box h3{margin:0 0 14px;font-size:16px;font-weight:650;color:var(--ink);letter-spacing:-.02em}.terms{background:#F6F6F1;border:1px solid var(--rule);border-radius:10px;padding:16px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--ink);line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;margin-top:18px;font-size:14px;table-layout:fixed}th{color:var(--muted);font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.06em;text-align:left;padding:10px 5px;border-bottom:1px solid var(--rule);font-weight:500;overflow-wrap:anywhere}td{padding:12px 5px;border-bottom:1px solid var(--rule);color:var(--ink);overflow-wrap:anywhere}
.fc{position:relative;display:flex;align-items:flex-end;gap:7px;height:90px;border-bottom:1px solid var(--rule);padding-bottom:2px;margin-top:30px}.bar{flex:1;background:#BACDB4;border-radius:4px 4px 0 0}.bar.breach{background:var(--coral)}.floor{position:absolute;left:0;right:0;border-top:2px dashed var(--coral)}
.decision{margin-top:20px;background:#E7EEE2;border:1px solid #CFDCC9;border-radius:14px;padding:21px 24px}.decision b{font-size:18px;color:var(--ink);letter-spacing:-.025em}.decision p{margin:8px 0 0}.reasons{margin:8px 0 0;padding-left:20px;color:var(--ink);font-size:15px;line-height:1.6}.kv{font-size:15px;display:grid;grid-template-columns:170px minmax(0,1fr);gap:10px 20px;margin-top:8px}.kv b{font-weight:450;color:var(--muted)}.kv span{color:var(--ink);font-weight:550;overflow-wrap:anywhere}.hash{font-family:'JetBrains Mono',monospace;font-size:11px;overflow-wrap:anywhere;color:var(--muted);margin-top:18px}
.btns{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}button.act{border:1px solid transparent;border-radius:10px;padding:13px 20px;font:600 14px Inter,ui-sans-serif,sans-serif;min-height:46px;cursor:pointer;background:var(--ink);color:#fff;line-height:1.4;white-space:normal}button.act:hover{background:#254F43}button.sec{background:#fff;color:var(--ink);border-color:#CCD3C8}button.sec:hover{background:var(--sage)}button.warn{background:var(--pale);color:var(--coral);border-color:#E7CDBF}button.warn:hover{background:#FFE6DB}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #7C9C72;outline-offset:3px}.side button.act{padding:9px 10px!important;font-size:12px!important;min-height:42px}.side #refresh{width:100%;margin:18px 0 9px!important;font-size:13px!important}.side #readhealth{font-size:12px!important;color:var(--muted)!important;margin:0 8px 12px}
.txn{display:flex;justify-content:space-between;gap:20px;padding:14px 0;border-bottom:1px solid var(--rule);font-size:14px;color:var(--ink);overflow-wrap:anywhere}.txn>span:first-child{min-width:0}.txn>span:last-child{text-align:right;flex-shrink:0;max-width:46%}.ok{color:#386A43;font-weight:650}.bad{color:var(--coral);font-weight:650}.audit{margin-top:22px}.audit .row{display:grid;grid-template-columns:170px minmax(0,1fr);gap:10px;font-size:12px;color:var(--muted);padding:11px 0;border-bottom:1px solid var(--rule);overflow-wrap:anywhere}.audit .row b{color:var(--ink);font-weight:600}.log{font-size:13px;color:var(--muted);margin-top:22px}.log div{padding:5px 0}.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;padding:14px 22px;border-radius:12px;font-size:14px;display:none;box-shadow:0 6px 24px #173b3220;max-width:calc(100vw - 32px);z-index:20}
.fld{display:block;font-size:14px;color:var(--muted);margin:16px 0}.fld input,.fld textarea{display:block;width:100%;margin-top:7px;border:1px solid #CCD3C8;border-radius:10px;padding:12px 14px;font:inherit;font-size:15px;color:var(--ink);background:#fff}.fld textarea{font-family:'JetBrains Mono',monospace;font-size:13px;resize:vertical}.srcnote{font-size:12px;color:var(--muted);background:#F6F6F1;border:1px solid var(--rule);border-radius:10px;padding:12px 14px;margin-bottom:14px;overflow-wrap:anywhere}p{line-height:1.6}blockquote{border-left:3px solid #BACDB4;margin:14px 0;padding:9px 16px;background:#F6F6F1;border-radius:0 8px 8px 0}pre{font-family:'JetBrains Mono',monospace;font-size:12px;overflow-wrap:anywhere}details{margin-top:14px}summary{cursor:pointer;min-height:44px;padding:9px 0;color:var(--ink)!important;font-size:14px!important}input[type=file]{font-size:14px;max-width:100%}input::file-selector-button{font:inherit;border:1px solid #CCD3C8;border-radius:8px;background:#F6F6F1;padding:10px;margin-right:12px;color:var(--ink)}
[style*="background:#fffaeb"],[style*="background:#fff7f5"],[style*="background:#fef3f2"]{background:var(--pale)!important;border-color:#E7CDBF!important;color:var(--ink)!important}[style*="background:#f9fafb"]{background:#F6F6F1!important;color:var(--muted)!important}[style*="color:#475467"],[style*="color:#344054"]{color:var(--ink)!important}
@media(min-width:1550px){.content{padding:48px 60px 90px}.box{padding:30px}}
@media(max-width:1100px){.wrap{grid-template-columns:240px minmax(0,1fr)}.side{padding:26px 14px}.content{padding:30px 24px 60px}.grid2{grid-template-columns:1fr}.panelhead{flex-direction:column;gap:8px}.panelhead .muted{max-width:100%;text-align:left}.box{padding:22px}}
.evidence details{margin-top:18px}.evidence summary{cursor:pointer;font-weight:600}.evidence-json{white-space:pre-wrap;overflow-wrap:anywhere;max-height:480px;overflow:auto;background:#f5f6f8;padding:16px;border-radius:8px;font-size:12px}.evidence-hash{font-family:monospace;overflow-wrap:anywhere;font-size:12px}.evidence-warning{border:1px solid #fdb022;background:#fffaeb;padding:10px 16px;border-radius:8px;margin:14px 0}.evidence-warning p{margin:4px 0}
@media(max-width:720px){.wrap{display:block}.side{position:static;min-height:0;border-right:0;border-bottom:1px solid var(--rule);padding:24px 18px}.org{padding-bottom:18px}.sidefoot{padding-top:14px}.sidefoot:after{display:none}.content{padding:28px 16px 60px}.panelhead h2{font-size:27px}.box{padding:20px 16px;border-radius:14px}.btns{gap:10px}.btns>button{flex:1 1 150px}.kv{grid-template-columns:105px minmax(0,1fr);gap:10px 12px;font-size:14px}.txn{flex-direction:column;gap:8px}.txn>span:last-child{text-align:left;max-width:100%}.audit .row{grid-template-columns:1fr;gap:4px}.decision{padding:18px}.terms{font-size:11px}table{font-size:12px}th{font-size:9px}.strip{font-size:11px}.toast{width:calc(100vw - 32px)}}
`;

export const pageJs = `
var metaToken = document.querySelector('meta[name="console-token"]');
var token = metaToken ? metaToken.content : null; // demo mode only; with real sign-in the session cookie is enough
var state = { cases: [], audit: [], sel: null, approval: null, cardRecon: null, showIntake: false, live: false };
function api(path, body) {
  var headers = { 'content-type': 'application/json' };
  if (token) headers['x-console-token'] = token;
  return fetch(path, { method: body ? 'POST' : 'GET', headers: headers, body: body ? JSON.stringify(body) : undefined }).then(function(r){ return r.json(); });
}
if (!token) { // signed-in mode: show who from the server, never from the URL or stored state
  api('/api/whoami').then(function(d){ if (d && d.identity) { var f = document.querySelector('.sidefoot'); if (f) f.textContent += ' - signed in as ' + (d.identity.email || d.identity.sub) + ' (' + d.identity.role + ')'; } }).catch(function(){});
}
function toast(msg) { var t = document.getElementById('toast'); t.textContent = msg; t.style.display = 'block'; setTimeout(function(){ t.style.display = 'none'; }, 3200); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]; }); }
function load() { var h = document.getElementById('readhealth'); if (h) h.textContent = 'Reading provider state...'; return api('/api/cases').then(function(d){ if (!d || d.error || !Array.isArray(d.cases)) throw new Error(d && d.error || 'Invalid response'); if (h) h.textContent = 'Snapshot loaded - refresh for latest'; state.snapshotAt = new Date().toISOString(); state.snapshotStale = false; state.cases = d.cases; state.audit = d.audit; state.notifications = d.notifications || []; state.live = !!d.live; var rs = document.getElementById('reset'); if (rs) rs.style.display = state.live ? 'none' : ''; if (!state.sel && d.cases.length) state.sel = d.cases[0].kase.id; render(); }).catch(function(){ state.snapshotStale = true; render(); if (h) h.textContent = 'Refresh failed - displayed snapshot may be stale'; toast('Could not refresh. Showing the previous snapshot, not current provider evidence.'); }); }
function current() { return state.cases.filter(function(c){ return c.kase.id === state.sel; })[0]; }
// Read-only evidence view: use the caller-authorized snapshot, never approval tokens or all-case audit.
function redactEvidenceDetail(value) {
  if(Array.isArray(value)) return value.map(redactEvidenceDetail);
  if(value && typeof value === 'object') { var out={}; Object.keys(value).forEach(function(k){out[k]=/^(nonce|signature|token|password|apiKey)$/i.test(k)?'[redacted]':redactEvidenceDetail(value[k]);});return out; }
  return value;
}
function caseEvidence(c) {
  return {
    schema: 'intentpay-case-evidence-v1',
    exportedAt: new Date().toISOString(), snapshotAt: state.snapshotAt || null, snapshotStale: !!state.snapshotStale,
    evidenceMode: state.live ? 'Configured Airwallex sandbox - read timestamps and failures below' : 'Local simulator - not real provider evidence',
    limits: ['Local application snapshot, not a signed provider attestation or settlement receipt.', 'Source checks are non-atomic; seller identity and forecast accuracy are not verified.', 'Case-filtered events may have predecessors outside this case and sensitive detail redactions; this export cannot independently verify the audit hash chain.'],
    caseId: c.kase.id, vendor: c.kase.vendor,
    termsSource: c.termsSource || 'Seeded simulator fixture', forecastSource: c.forecastSource || 'Scenario input - not a bank feed',
    source: c.contractSource ? { id: c.contractSource.id, version: c.contractSource.version, invalidated: !!c.sourceInvalidated } : null,
    decision: c.decision,
    approvedIntent: c.intent ? { id:c.intent.id, termsHash:c.intent.termsHash, intentHash:c.intentHash, cadence:c.intent.cadence, amountCap:c.intent.amountCap, currency:c.intent.currency, categories:c.intent.categories } : null,
    authority: { rejected:!!c.rejected, requiresReapproval:!!c.requiresReapproval, issuanceUnresolved:!!c.createCardUnresolved, authorizationUnresolved:!!(c.pendingAuthorization && !c.pendingAuthorization.reconciledAt), freezeState:c.freezeState || 'not requested' },
    card: c.card ? { id:c.card.id, status:c.card.status, controls:c.card.controls } : null,
    cardStatusRead:c.cardStatusRead || null, ledger:c.ledger || null,
    authorizations:c.transactions,
    events:(state.audit || []).filter(function(a){ return a.caseId === c.kase.id; }).map(function(a){return {seq:a.seq,ts:a.ts,kind:a.kind,caseId:a.caseId,detail:redactEvidenceDetail(a.detail),prev:a.prev,hash:a.hash};})
  };
}
function evidencePanel(c) {
  var e=caseEvidence(c);
  var warnings=[];
  if(e.snapshotStale) warnings.push('Snapshot refresh failed: displayed and exported data may be stale.');
  if(e.authority.rejected) warnings.push('Rejected: no further purchase authority.');
  if(e.authority.requiresReapproval || (e.source && e.source.invalidated)) warnings.push('Changed or unverifiable source: previous approval must not be reused.');
  if(e.authority.issuanceUnresolved || e.authority.authorizationUnresolved) warnings.push('Unresolved outcome: spending locked pending reconciliation.');
  if(e.authority.freezeState === 'unknown' || e.authority.freezeState === 'pending') warnings.push('Freeze unverified: do not assume the old card is stopped.');
  if(e.cardStatusRead && e.cardStatusRead.state !== 'ok') warnings.push('Card status read failed: saved status is not current evidence.');
  if(e.ledger && e.ledger.state !== 'ok') warnings.push('Ledger unavailable or stale: this is not proof of no transactions.');
  return '<div class="box evidence" style="margin-top:14px"><h3>Inspect the decision-to-control chain</h3><p class="srcnote">' + esc(e.evidenceMode) + '. Read-only snapshot; opening or downloading this view makes no approval, card or purchase action.</p>' +
    (warnings.length ? '<div role="status" class="evidence-warning">'+warnings.map(function(w){return '<p>'+esc(w)+'</p>';}).join('')+'</div>' : '') +
    '<div class="kv"><b>Approved terms hash</b><span class="evidence-hash">'+esc(e.approvedIntent ? e.approvedIntent.termsHash : 'No approved intent')+'</span><b>Approved intent hash</b><span class="evidence-hash">'+esc(e.approvedIntent ? e.approvedIntent.intentHash : 'No approved intent')+'</span><b>Source version</b><span class="evidence-hash">'+esc(e.source ? e.source.version : 'No Salesforce source version')+'</span><b>Exact-case events</b><span>'+e.events.length+' visible to this session (no other-case or global events)</span></div>' +
    '<details><summary>Read the full case snapshot and ordered events</summary><p class="srcnote">Full detail with credential-shaped fields and approval nonces redacted. An empty event list can mean this session cannot view audit details, not that nothing happened. Export may contain business and operator details. Keep it private unless approved.</p><pre class="evidence-json">'+esc(JSON.stringify(e,null,2))+'</pre></details><div class="btns"><button class="act sec" id="export-evidence">Download this case snapshot (JSON)</button></div><p class="srcnote">Local application evidence, not a signed provider attestation. Authorizations are not settlement. A case-filtered audit subset cannot independently verify the whole hash chain.</p></div>';
}

function render() {
  var q = document.getElementById('cases');
  q.innerHTML = state.cases.map(function(c){
    var stage = c.rejected ? 'rejected - no further purchase' : c.createCardUnresolved ? 'card issuance unresolved - locked' : (c.pendingAuthorization && !c.pendingAuthorization.reconciledAt) ? 'authorization unresolved - locked' : c.freezeState === 'unknown' || c.freezeState === 'pending' ? 'freeze unverified - blocked' : c.requiresReapproval ? 'deal changed - review required' : c.cardStatusRead && c.cardStatusRead.state !== 'ok' ? 'card status unknown' : c.card ? (c.card.status === 'CLOSED' ? 'card closed' : c.card.status === 'FROZEN' ? 'card frozen' : 'card active') : (c.intent ? 'approved' : (c.rejected ? 'rejected' : 'awaiting review'));
    return '<button class="casebtn' + (c.kase.id === state.sel ? ' on' : '') + '" data-id="' + esc(c.kase.id) + '"><b>' + esc(c.kase.vendor) + '</b><span>' + stage + '</span></button>';
  }).join('');
  Array.prototype.forEach.call(q.querySelectorAll('.casebtn'), function(b){ b.onclick = function(){ state.sel = b.dataset.id; state.approval = null; state.cardRecon = null; render(); }; });
  var c = current(); var p = document.getElementById('panel');
  if (state.showIntake) { renderIntake(p); return; }
  if (!c) {
    p.innerHTML = '<div class="panelhead"><h2>Purchase intents</h2></div><div class="box"><h3>No cases yet</h3><p class="muted">This console started with an empty queue. Create a case from real vendor terms to begin; the case then runs the full lifecycle here: extraction, policy decision, approval, card issuance, authorizations, freeze and reconcile.</p><div class="btns"><button class="act" id="empty-newcase">Create a case from vendor terms</button></div></div>';
    document.getElementById('empty-newcase').onclick = function(){ state.showIntake = true; render(); };
    return;
  }
  var t = c.kase.terms, d = c.decision, f = c.kase;
  var floorRows = '';
  var maxB = Math.max.apply(null, currentForecast(c));
  var bars = currentForecast(c).map(function(b, w){
    var h = Math.round(70 * b / (maxB || 1));
    var breach = d.cadence !== 'ESCALATE' && d.annualBreachWeek === w + 1;
    return '<div class="bar' + (breach ? ' breach' : '') + '" style="height:' + h + 'px" title="week ' + (w + 1) + ': ' + b + '"></div>';
  }).join('');
  var txns = c.transactions.map(function(t){
    var ok = t.status === 'CLEARING' || t.status === 'PENDING';
    return '<div class="txn"><span>' + esc(t.id.slice(0, 14)) + ' - ' + t.amount + ' ' + esc(t.currency) + ' at ' + esc(t.merchant || '') + '</span><span class="' + (ok ? 'ok' : 'bad') + '">' + t.status + (t.failureReason ? ' (' + esc(t.failureReason) + ')' : '') + '</span></div>';
  }).join('');
  var audit = state.audit.filter(function(a){ return !a.caseId || a.caseId === c.kase.id; }).slice(-8).map(function(a){ return '<div class="row"><b>' + esc(a.kind) + '</b>' + (a.caseId ? '' : '<span class="muted">(all cases)</span>') + '<span>' + esc(JSON.stringify(a.detail).slice(0, 120)) + '</span></div>'; }).join('');
  p.innerHTML =
    (c.createCardUnresolved ? '<div class="decision" style="border-color:#fdb022;background:#fffaeb;margin:0 0 16px"><b>Card issuance outcome unresolved - locked.</b><p>The provider did not confirm issuance (' + esc(c.createCardUnresolved.error) + '). A retry with a fresh approval could create a SECOND card, so approvals and card creation stay blocked until an operator checks the provider card list.</p><button class="act sec" id="reconcile-card">Check provider cards</button>' + (state.cardRecon ? '<div style="margin-top:10px">' + (state.cardRecon.length ? state.cardRecon.map(function(rc){ return '<div class="txn"><span>' + esc(rc.id) + ' (' + esc(rc.status) + ')</span><span><button class="act sec" data-adopt="' + esc(rc.id) + '" style="padding:4px 10px;font-size:11px">Adopt (verify controls)</button> <button class="act warn" data-stray="' + esc(rc.id) + '" style="padding:4px 10px;font-size:11px">Freeze stray</button></span></div>'; }).join('') : '<p class="muted">The provider lists no cards for this cardholder.</p><button class="act warn" id="reconcile-card-none">Attest: no card was created - unlock for a fresh approval</button>') + '</div>' : '') + '</div>' : '') +
    (c.pendingAuthorization ? '<div class="decision" style="border-color:#fdb022;background:#fffaeb;margin:0 0 16px"><b>' + (c.pendingAuthorization.reconciledAt ? 'Manually confirmed - retry unlocked.' : c.pendingAuthorization.probableMatch ? 'Probable ledger match - operator review required.' : 'Authorization outcome unresolved - locked.') + '</b><p>' + (c.pendingAuthorization.reconciledAt ? 'Local operator attestation at ' + esc(c.pendingAuthorization.reconciledAt) + ': ' + esc(c.pendingAuthorization.manualConfirm || '') + ' (A local operator action, not proof of provider finality.) The retry reuses the original request id.' : c.pendingAuthorization.probableMatch ? 'Reconcile found ' + esc(c.pendingAuthorization.probableMatch.transactionId) + ' (' + esc(c.pendingAuthorization.probableMatch.status) + ') matching card, amount, currency, merchant and time window - heuristic only, it may be an unrelated payment. Spending stays locked until an operator reviews it.' : 'The gateway did not confirm the last purchase attempt (' + esc(c.pendingAuthorization.lastError || 'no detail') + '). Purchases on this card are locked until reconciliation. A ledger no-match does not unlock on its own - ledger visibility can lag and this endpoint documents no idempotency guarantee.') + '</p><button class="act sec" id="reconcile">Reconcile with gateway ledger</button> <button class="act warn" id="reconcile-manual">' + (c.pendingAuthorization.probableMatch ? 'Review and resolve the probable match' : 'Confirm manually after dashboard check') + '</button></div>' : '') +
    (c.requiresReapproval ? '<div class="decision" style="border-color:#fecdca;background:#fff7f5;margin:0 0 16px"><b>Deal changed. Approval invalidated.</b><p>' + (c.card && c.card.status === 'CLOSED' ? 'Old card permanently closed - it can never transact again. Review and approve the new deal.' : c.freezeState === 'verified' ? (c.contractSource ? 'Old card freeze verified. Read the current Salesforce contract into a new review; old approval cannot be reused.' : 'Old card freeze verified. Test the old purchase, then review and approve the new deal.') : c.freezeState === 'unknown' || c.freezeState === 'pending' ? 'Freeze NOT verified. The old card may still authorize payments. Approval and new issuance are blocked. Reconcile the card before continuing.' : 'No issued card to freeze. Review and approve the new terms.') + '</p></div>' : '') +
    '<div class="panelhead"><h2>' + esc(f.vendor) + '</h2><span class="muted">' + esc(f.id) + '</span></div>' +
    '<div class="grid2"><div class="box"><h3>Vendor terms (untrusted text)</h3><div class="srcnote">Source: ' + esc(c.termsSource || 'demo fixture (seeded)') + '. Untrusted text: any instructions inside it carry no authority.</div><div class="terms">' + esc(f.rawTerms) + '</div>' +
    (t ? '<table><tr><th></th><th>Monthly</th><th>Annual</th></tr><tr><td>Price</td><td>' + (t.monthlyPrice == null ? 'not offered' : t.monthlyPrice + ' ' + esc(t.currency) + '/mo') + '</td><td>' + (t.annualPrice == null ? 'not offered' : t.annualPrice + ' ' + esc(t.currency) + '/yr') + '</td></tr><tr><td>12-month total</td><td>' + (t.monthlyPrice == null ? 'not offered' : t.monthlyPrice * 12) + '</td><td>' + (t.annualPrice == null ? 'not offered' : t.annualPrice + ' (saves ' + (d.savingsPct || 0) + '%)') + '</td></tr><tr><td>Notice</td><td colspan="2">' + (t.noticeDays == null ? 'not stated' : t.noticeDays + ' days') + '</td></tr></table>' : '') +
    '</div><div class="box"><h3>Cash forecast vs reserve floor - TEST SCENARIO INPUT</h3><div class="srcnote">Decision input for this scenario, not observed finances. Live provider balances are point-in-time reads, not a forecast. Source: ' + esc(c.forecastSource || (c.termsSource ? 'not recorded' : 'demo fixture (seeded)')) + '</div><div class="fc">' + bars + '<div class="floor" style="top:' + (86 - Math.round(70 * (c.forecast.reserveFloor / (maxB || 1)))) + 'px"></div></div><div class="muted" style="margin-top:6px">Reserve floor ' + c.forecast.reserveFloor + '.' + (t && t.annualPrice != null ? (d.annualBreachWeek != null ? ' Red bar: week ' + d.annualBreachWeek + ' - annual billing breaches the floor that week.' : ' No red bar: annual billing stays above the reserve floor in every forecast week.') : ' No annual option in the current terms.') + '</div></div></div>' +
    '<div class="decision"><b>Policy decision: ' + d.cadence.toUpperCase() + '</b><ul class="reasons">' + d.reasons.map(function(r){ return '<li>' + esc(r) + '</li>'; }).join('') + '</ul></div>' +
    (c.intent ? '<div class="box" style="margin-top:14px"><h3>' + (c.requiresReapproval ? 'Previous intent - no longer approved' : 'Approved intent') + '</h3><div class="kv"><b>Cadence</b><span>' + esc(c.intent.cadence) + '</span><b>Cap</b><span>' + esc(c.intent.amountCap) + ' ' + esc(c.intent.currency) + ' per transaction</span><b>Categories</b><span>' + esc(c.intent.categories.join(', ')) + '</span><b>Reconsider</b><span>' + esc(c.intent.reconsiderAt || 'at renewal') + '</span></div><div class="hash">terms ' + esc(c.intent.termsHash) + '</div></div>' : '') +
    (c.card ? '<div class="box" style="margin-top:14px"><h3>Card ' + esc(c.card.id.slice(0, 16)) + ' - approved controls at issuance</h3><div class="kv"><b>Limit</b><span>' + esc(c.card.controls.amountLimit) + ' per transaction (inclusive)</span><b>Currencies</b><span>' + esc(c.card.controls.currencyAllowlist.join(', ')) + '</span><b>Categories</b><span>' + esc(c.card.controls.merchantCategories.join(', ')) + '</span><b>Status</b><span>' + esc(c.cardStatusRead && c.cardStatusRead.state !== 'ok' ? 'UNKNOWN - saved status ' + c.card.status : c.freezeState === 'unknown' || c.freezeState === 'pending' ? 'UNKNOWN - last confirmed ' + c.card.status : c.card.status) + '</span><b>Status source</b><span>' + esc(c.cardStatusRead ? (c.cardStatusRead.state === 'ok' ? 'Provider read at ' : 'Read failed at ') + c.cardStatusRead.checkedAt : 'Saved snapshot - not a current provider read') + '</span></div></div>' : '') +
    (c.intent && !c.requiresReapproval ? '<div class="box" style="margin-top:14px"><h3>Notice to decision</h3><p class="muted">Upload a plain-text .eml or .txt notice for this vendor. Headers are unverified, content is untrusted. Analysis proposes only: no card action until you review and apply.</p><input type="file" id="notice-file" accept=".eml,.txt,text/plain,message/rfc822"><div class="btns"><button class="act sec" id="notice-analyse">Analyse notice (model)</button></div></div>' : '') +
    (c.noticeProposal ? '<div class="box" style="margin-top:14px"><h3>Notice proposal: ' + esc(c.noticeProposal.status) + '</h3><p class="srcnote">' + esc(c.noticeProposal.source.filename) + ' - ' + esc(c.noticeProposal.source.trust) + '</p><p>' + esc(c.noticeProposal.rationale) + '</p>' + (c.noticeProposal.missingFields ? '<p><b>Needed before any decision:</b> ' + esc(c.noticeProposal.missingFields.join(', ')) + '</p>' : '') + '<table><tr><th>Changed field</th><th>Approved</th><th>Proposed</th></tr>' + c.noticeProposal.changes.map(function(x){return '<tr><td>'+esc(({monthlyPrice:'Monthly price',annualPrice:'Annual price',currency:'Currency',category:'Category',noticeDays:'Notice period (days)'})[x.field] || x.field)+'</td><td>'+esc(x.before == null ? 'not stated' : x.before)+'</td><td>'+esc(x.after == null ? 'not stated' : x.after)+'</td></tr>';}).join('') + '</table>' + (c.noticeProposal.decision ? '<p><b>Code policy: '+esc(c.noticeProposal.decision.cadence)+'</b>. '+esc(c.noticeProposal.decision.reasons.join('; '))+'</p>' : '') + '<h3>Supporting words</h3>' + c.noticeProposal.citations.map(function(x){return '<blockquote>'+esc(x)+'</blockquote>';}).join('') + '<details><summary>Read the uploaded notice</summary><pre style="white-space:pre-wrap">'+esc(c.noticeProposal.rawTerms)+'</pre></details><p class="muted">Applying invalidates the old approval and attempts to freeze its card. It does not cancel a contract or approve replacement spending. Missing facts are not filled from the old deal.</p>' + (c.noticeProposal.status === 'review' ? '<div class="btns"><button class="act warn" id="notice-apply">I reviewed this change: apply and freeze old card</button></div>' : '') + '</div>' : '') +
    '<div class="btns">' +
    (c.intent && !c.requiresReapproval && !c.termsSource && !state.live ? '<button class="act warn" id="change-deal">Demo fixture: cheaper deal arrives</button>' : '') +
    (c.intent && !c.requiresReapproval ? '<button class="act sec" id="change-real">Change deal: enter real terms</button>' : '') +
    (!c.intent && !c.card ? '<button class="act sec" id="extract">Extract terms (model)</button>' : '') +
    (!c.createCardUnresolved && d.cadence !== 'ESCALATE' && c.freezeState !== 'unknown' && c.freezeState !== 'pending' && (!c.intent || c.requiresReapproval || (c.card && c.card.status === 'CLOSED')) ? '<button class="act" id="approve">' + (c.requiresReapproval ? 'Approve new deal' : (c.card && c.card.status === 'CLOSED') ? 'Approve fresh intent' : 'Approve intent') + '</button>' : '') +
    (!c.createCardUnresolved && c.intent && !c.requiresReapproval && (!c.card || ((c.card.status === 'FROZEN' || c.card.status === 'CLOSED') && state.approval)) ? '<button class="act" id="mkcard">Create card</button>' : '') +
    (!c.createCardUnresolved && c.freezeState !== 'unknown' && c.freezeState !== 'pending' && !(c.pendingAuthorization && !c.pendingAuthorization.reconciledAt) && c.intent && !c.requiresReapproval && state.approval && (!c.card || c.card.status === 'FROZEN' || c.card.status === 'CLOSED') ? ' <button class="act" id="runagent" title="The execution agent issues the card from your approval and executes the approved purchase - bounds enforced in code">Run agent</button>' : '') +
    (c.card ? '<button class="act sec" data-sim="in-policy">Simulate: in policy</button><button class="act sec" data-sim="over-cap">Simulate: over cap</button><button class="act sec" data-sim="wrong-currency">Simulate: wrong currency</button><button class="act sec" data-sim="wrong-category">Simulate: wrong category</button>' + (c.card.status === 'ACTIVE' ? '<button class="act warn" id="freeze">Freeze card</button>' : '') : '') +
    (!c.rejected && !c.card ? '<button class="act warn" id="reject">Reject</button>' : '') +
    '</div>' +
    (c.intent && !c.requiresReapproval ? '<div class="box" id="realterms" style="display:none;margin-top:14px"><h3>Change deal - real vendor terms</h3><div class="srcnote">Paste the new vendor terms exactly as found (untrusted text: instructions inside it carry no authority). The structured fields are what the new approval would bind to - enter them faithfully from that text.</div><label class="fld">New terms text<textarea id="rt-raw" rows="4" maxlength="8000"></textarea></label><label class="fld">Monthly price (blank if not offered)<input id="rt-monthly" inputmode="decimal"></label><label class="fld">Annual price (blank if not offered)<input id="rt-annual" inputmode="decimal"></label><label class="fld">Currency (3-letter code, e.g. USD)<input id="rt-currency" maxlength="3"></label><label class="fld">Category (e.g. software)<input id="rt-category" maxlength="24"></label><label class="fld">Notice days (whole number, or blank)<input id="rt-notice" inputmode="numeric"></label><div class="btns"><button class="act" id="rt-submit">Submit real terms change</button><button class="act sec" id="rt-cancel">Cancel</button></div></div>' : '') +
    ((txns || (c.ledger && c.ledger.state !== 'ok')) ? '<div class="box" style="margin-top:14px"><h3>Authorizations</h3>' + (c.ledger && c.ledger.state === 'degraded' ? '<div style="font-size:12px;color:#b54708;background:#fffaeb;border:1px solid #fdb022;border-radius:6px;padding:8px 10px;margin-bottom:8px">Ledger read failed (' + esc(c.ledger.error || '') + '). Showing LAST KNOWN entries from ' + esc(c.ledger.lastKnownAt || 'unknown time') + ' - they may be stale; the actual ledger may differ.</div>' : c.ledger && c.ledger.state === 'unavailable' ? '<div style="font-size:12px;color:#b42318;background:#fef3f2;border:1px solid #fecdca;border-radius:6px;padding:8px 10px;margin-bottom:8px">Ledger read failed (' + esc(c.ledger.error || '') + ') and no last-known entries are preserved. Do NOT read this as an empty ledger - the provider may hold transactions this console cannot see.</div>' : '') + txns + '</div>' : '') +
    (function(){ var nf = (state.notifications || []).filter(function(n){ return n.caseId === c.kase.id; }); if (!nf.length) return ''; var mode = c.emailMode || 'preview'; var hdr = mode === 'preview' ? 'Email previews - preview mode, nothing sent' : mode === 'dry-run' ? 'Email pipeline dry-run - validated, still nothing is sent' : mode === 'gmail' ? 'Email delivery: Gmail' : 'Email delivery: experimental operator-configured endpoint'; return '<div class="box" style="margin-top:14px"><h3>' + hdr + '</h3>' + nf.map(function(n){ var st = n.status === 'preview' ? 'preview' : n.status === 'dry-run' ? (mode === 'http' ? 'dry-run, not sent - never auto-sent on a mode switch; explicit operator promotion only' : 'dry-run, not sent') : n.status === 'sent' ? 'sent ' + esc((n.receipt && n.receipt.at) || '') + ((n.receipt && n.receipt.promoted) ? ' (operator-promoted from dry-run)' : '') : 'FAILED - ' + ((n.receipt && n.receipt.ambiguous) ? 'outcome UNKNOWN, may have been sent' : 'not sent') + ': ' + esc((n.receipt && n.receipt.error) || '') + ' - needs operator review, no auto-resend'; return '<details style="padding:6px 0;border-bottom:1px solid #f0f2f3"><summary style="font-size:12.5px;cursor:pointer;color:#344054"><b>' + esc(n.subject) + '</b> <span class="muted">to ' + esc(n.to) + ' - ' + st + '</span></summary><pre style="white-space:pre-wrap;font-size:12px;color:#475467;background:#f9fafb;border-radius:6px;padding:10px;margin:6px 0">' + esc(n.body) + '</pre></details>'; }).join('') + '</div>'; })() +
    (c.log.length ? '<div class="log">' + c.log.map(function(l){ return '<div>' + esc(l) + '</div>'; }).join('') + '</div>' : '') +
    '<div class="box audit"><h3>Recent audit activity</h3><p class="srcnote">Last eight visible case or global events. Full exact-case entries are in the inspector below.</p>' + audit + '</div>' + evidencePanel(c);
  document.getElementById('export-evidence').onclick = function(){ var blob=new Blob([JSON.stringify(caseEvidence(c),null,2)],{type:'application/json'}); var url=URL.createObjectURL(blob); var a=document.createElement('a'); a.href=url; a.download='intentpay-case-evidence.json'; a.click(); setTimeout(function(){URL.revokeObjectURL(url);},1000); };
  if (c.rejected) { p.insertAdjacentHTML('afterbegin', '<div class="decision" role="status"><b>Case rejected.</b><p>No new approval, card or purchase is allowed on this case. Create a new case for a fresh review.</p></div>'); p.querySelectorAll('#approve,#mkcard,#runagent,#extract,#change-real,#change-deal,#notice-analyse,#notice-apply,[data-sim]').forEach(function(b){b.remove();}); }
  if(c.contractSource){p.insertAdjacentHTML('afterbegin','<div class="box"><h3>Salesforce Contract source</h3><p>Untrusted test contract. Fresh source check before approval, issue and purchase.</p><p>'+esc(c.contractSource.id)+' · version '+esc(c.contractSource.version.slice(0,12))+'</p><p>'+esc(c.sourceInvalidated?'SOURCE CHANGED OR UNAVAILABLE - old approval blocked':'Imported snapshot; source rechecked on action')+'</p><button class="act sec" id="sf-refresh">Read current contract into new review</button></div>');document.getElementById('sf-refresh').onclick=function(){if(!confirm('Create a fresh review from Salesforce? The old case is invalidated and its card frozen. No approval is inherited.'))return;api('/api/salesforce/import',{contractId:c.contractSource.id,previousCaseId:c.kase.id,confirm:true,weeklyBalances:c.forecast.weeklyBalances,reserveFloor:c.forecast.reserveFloor,forecastSource:c.forecastSource}).then(function(d){if(d.error){toast(d.error);load();return;}state.sel=d.case.kase.id;state.approval=null;toast('Fresh contract review created; extract and approve separately');load();});};}
  if(c.contractSource){p.querySelectorAll('#change-real,#change-deal,#notice-analyse,#notice-file').forEach(function(b){b.remove();});if(c.sourceInvalidated)p.querySelectorAll('#approve,#mkcard,#runagent,[data-sim]').forEach(function(b){b.remove();});}
  var na = document.getElementById('notice-analyse');
  if (na) na.onclick = async function(){
    var input = document.getElementById('notice-file'); var file = input && input.files && input.files[0];
    if (!file) { toast('Select a .txt or plain-text .eml notice first.'); return; }
    if(file.size > 32000){toast('Notice too large. Use a plain-text excerpt under 8000 characters.');return;}
    na.disabled = true; na.textContent = 'Reading and comparing notice...';
    try { var result = await api('/api/notice-propose', {caseId:c.kase.id, filename:file.name, content:await file.text()}); if(result.error)toast(result.error); else toast('Analysis saved. Review the evidence before any change.'); load(); } catch(e){toast('Analysis unavailable; no card action made.');load();}
  };
  var nap = document.getElementById('notice-apply');
  if(nap) nap.onclick = async function(){
    if(!confirm('Apply this reviewed proposal? This invalidates the old approval and freezes its card. It does not cancel the contract or approve a replacement purchase.'))return;
    nap.disabled=true;
    try {var result=await api('/api/notice-apply',{caseId:c.kase.id,proposalId:c.noticeProposal.id,confirm:true});state.approval=null;toast(result.error || 'Applied. Check freeze status, then review fresh spending authority.');load();} catch(e){state.approval=null;toast('Apply outcome unknown. Refresh and check state before doing anything else.');load();}
  };
  var change = document.getElementById('change-deal');
  if (change) change.onclick = function(){
    if (!confirm('DEMO FIXTURE: this injects a SYNTHETIC cheaper deal (not real vendor terms) to exercise the terms-change flow. For a real change use "Change deal: enter real terms". Continue with the fixture?')) return;
    var terms = Object.assign({}, t, { monthlyPrice: Math.max(1, t.monthlyPrice - 10) });
    var rawTerms = 'Demo fixture updated vendor offer: ' + terms.monthlyPrice + ' ' + terms.currency + ' per month, ' + terms.annualPrice + ' annually. Category: ' + terms.category + '. ' + terms.noticeDays + ' days notice.';
    api('/api/change-terms', { caseId: c.kase.id, terms: terms, rawTerms: rawTerms }).then(function(d2){ state.approval = null; if(d2 && d2.error){toast(d2.error);}else{toast('Old card frozen. Approval invalidated. Review the changed deal.');} load(); }, function(){ toast('Terms-change outcome unknown: response lost. Refresh and check the provider before retrying.'); });
  };
  var creal = document.getElementById('change-real');
  if (creal) creal.onclick = function(){ var f = document.getElementById('realterms'); if (f) f.style.display = (f.style.display === 'none' ? 'block' : 'none'); };
  var rtc = document.getElementById('rt-cancel');
  if (rtc) rtc.onclick = function(){ document.getElementById('realterms').style.display = 'none'; };
  var rts = document.getElementById('rt-submit');
  if (rts) rts.onclick = function(){
    var raw = document.getElementById('rt-raw').value.trim();
    var cur = document.getElementById('rt-currency').value.trim().toUpperCase();
    var cat = document.getElementById('rt-category').value.trim();
    function num(id, whole) { var v = document.getElementById(id).value.trim(); if (v === '') return null; var n = Number(v); if (!isFinite(n) || n < 0 || (whole && Math.floor(n) !== n)) return undefined; return n; }
    var monthly = num('rt-monthly', false), annual = num('rt-annual', false), notice = num('rt-notice', true);
    if (monthly === undefined || annual === undefined || notice === undefined) { toast('Prices and notice must be non-negative numbers (notice a whole number), or left blank'); return; }
    if (monthly === null && annual === null) { toast('At least one of monthly or annual price is required'); return; }
    if (!raw) { toast('Paste the new terms text'); return; }
    if (!/^[A-Z]{3}$/.test(cur)) { toast('Currency must be a 3-letter code'); return; }
    if (cat.length < 3 || cat.length > 24) { toast('Category is required (3-24 chars)'); return; }
    api('/api/change-terms', { caseId: c.kase.id, terms: { monthlyPrice: monthly, annualPrice: annual, currency: cur, category: cat, noticeDays: notice }, rawTerms: raw }).then(function(d2){ if (d2 && d2.error) { toast(d2.error); load(); return; } state.approval = null; toast('Old card frozen. Approval invalidated. Review the changed deal.'); load(); }, function(){ toast('Terms-change outcome unknown: response lost. Refresh and check the provider before retrying.'); });
  };
  var ex = document.getElementById('extract');
  if (ex) ex.onclick = function() { toast('Extracting terms with the model...'); api('/api/extract', { caseId: c.kase.id }).then(function(d2){ if (d2.error) { toast(d2.error); return; } var p = d2.plan || {}; if (p.ok) { toast('Extraction accepted by governance - a person still approves'); } else { toast('Model extraction not adopted - human-entered terms stand'); } load(); }); };
  var ap = document.getElementById('approve');
  if (ap) ap.onclick = function() { api('/api/approve', { caseId: c.kase.id }).then(function(d2){ if (d2.error) { toast(d2.error); return; } state.approval = d2.approval; toast('Intent approved - bound to these exact terms'); load(); }); };
  var mk = document.getElementById('mkcard');
  if (mk) mk.onclick = function() {
    var doCreate = function(approval) {
      api('/api/create-card', { approval: approval }).then(function(d2){ if (d2.error) { toast(d2.error); return; } toast('Card created - controls mirror the approved intent'); load(); });
    };
    if (state.approval) { doCreate(state.approval); return; }
    toast('Approve the intent first');
  };
  var ra = document.getElementById('runagent');
  if (ra) ra.onclick = function() {
    if (!state.approval) { toast('Approve the intent first'); return; }
    ra.disabled = true; toast('Agent running: issuing the card and executing the approved purchase...');
    api('/api/agent-run', { caseId: c.kase.id, approval: state.approval }).then(function(d2){
      if (d2.error) { toast(d2.error); load(); return; }
      state.approval = null;
      var r = d2.run || {};
      toast(r.ok ? ('Agent run complete: ' + (r.summary || 'purchase executed')) : ('Agent run ended: ' + (r.summary || r.error || 'see the case log')));
      load();
    }, function(){ toast('Agent-run outcome unknown: response lost. Refresh and reconcile before retrying.'); load(); });
  };
  Array.prototype.forEach.call(p.querySelectorAll('[data-sim]'), function(b){ b.onclick = function(){ api('/api/simulate', { caseId: c.kase.id, kind: b.dataset.sim }).then(function(d2){ if (d2.error) { toast(d2.error); load(); return; } var t = d2.transaction; toast(t.status === 'CLEARING' ? 'Cleared: ' + t.amount + ' ' + t.currency : 'Declined: ' + t.failureReason + ' - the card enforced the intent'); load(); }); }; });
  var fr = document.getElementById('freeze');
  if (fr) fr.onclick = function(){ api('/api/freeze', { caseId: c.kase.id }).then(function(d2){ toast(d2.error || 'Card freeze verified'); load(); }); };
  var rec = document.getElementById('reconcile');
  if (rec) rec.onclick = function(){ api('/api/reconcile', { caseId: c.kase.id }).then(function(d2){ if (d2.error) { toast(d2.error); load(); return; } toast(d2.outcome === 'matched' ? 'Reconciled: the attempt was found in the gateway ledger and recorded' : d2.outcome === 'probable_match' ? 'Probable match found - lock stays until an operator reviews it' : 'No match in the ledger - lock stays; re-check later or confirm manually'); load(); }); };
  var recm = document.getElementById('reconcile-manual');
  if (recm) recm.onclick = function(){ var why = prompt(c.pendingAuthorization && c.pendingAuthorization.probableMatch ? 'Review the probable match against the provider record: state your resolution (min 8 chars).' : 'Confirm you checked the provider dashboard: state what you verified (min 8 chars). This is a local operator attestation, not proof of provider finality.'); if (!why) return; api('/api/reconcile', { caseId: c.kase.id, manualConfirm: why }).then(function(d2){ if (d2.error) { toast(d2.error); load(); return; } toast('Local operator attestation recorded - lock resolved'); load(); }); };
  var rcc = document.getElementById('reconcile-card');
  if (rcc) rcc.onclick = function(){ api('/api/reconcile-card', { caseId: c.kase.id, decision: 'check' }).then(function(d2){ if (d2.error) { toast(d2.error); load(); return; } state.cardRecon = d2.remoteCards || []; render(); }); };
  Array.prototype.forEach.call(p.querySelectorAll('[data-adopt]'), function(b){ b.onclick = function(){ api('/api/reconcile-card', { caseId: c.kase.id, decision: 'adopt', cardId: b.dataset.adopt }).then(function(d2){ if (d2.error) { toast(d2.error); load(); return; } state.cardRecon = null; toast('Card adopted from the provider listing - issuance lock cleared'); load(); }); }; });
  var rcn = document.getElementById('reconcile-card-none');
  if (rcn) rcn.onclick = function(){ var why = prompt('Confirm you checked the provider card list directly: state what you verified (min 8 chars). This attestation is recorded in the audit trail.'); if (!why) return; api('/api/reconcile-card', { caseId: c.kase.id, decision: 'none-created', attestation: why }).then(function(d2){ if (d2.error) { toast(d2.error); load(); return; } state.cardRecon = null; toast('Attestation recorded - lock cleared; approve again to issue'); load(); }); };
  Array.prototype.forEach.call(p.querySelectorAll('[data-stray]'), function(b){ b.onclick = function(){ api('/api/reconcile-card', { caseId: c.kase.id, decision: 'freeze-stray', cardId: b.dataset.stray }).then(function(d2){ if (d2.error) { toast(d2.error); load(); return; } state.cardRecon = null; toast('Stray card frozen at the provider - lock cleared; approve again to issue'); load(); }); }; });
  var rj = document.getElementById('reject');
  if (rj) rj.onclick = function(){ var reason = prompt('Why are you rejecting this purchase?'); if (!reason) return; api('/api/reject', { caseId: c.kase.id, reason: reason }).then(function(d2){ if (d2 && d2.error) { toast('Rejection failed: ' + d2.error + ' - the case was NOT rejected'); load(); return; } toast(c.card ? 'Rejected - existing card permanently closed' : 'Rejected - no card was created'); load(); }, function(){ toast('Rejection outcome unknown: response lost. Refresh before retrying.'); }); };
}
function renderIntake(p) {
  p.innerHTML =
    '<div class="panelhead"><h2>New case from vendor terms</h2></div>' +
    '<div class="box"><h3>Vendor terms (untrusted text)</h3>' +
    '<div class="srcnote">Paste the vendor pricing text exactly as found. It is treated as untrusted data: instructions inside it carry no authority, extraction is gated, and a person still approves the intent.</div>' +
    '<label class="fld">Salesforce Contract ID (optional, replaces pasted terms)<input id="in-contract" placeholder="800..."></label>' +
    '<label class="fld">Vendor name<input id="in-vendor" maxlength="120"></label>' +
    '<label class="fld">Terms text<textarea id="in-terms" rows="6" maxlength="8000"></textarea></label>' +
    '<label class="fld">Terms source (required)<input id="in-source" maxlength="200" placeholder="e.g. pricing page, invoice from inbox"></label>' +
    '</div>' +
    '<div class="box" style="margin-top:14px"><h3>Cash forecast - TEST SCENARIO INPUT</h3>' +
    '<div class="srcnote">Decision inputs for this test scenario, not observed finances. Live provider balances are point-in-time reads, not a forecast.</div>' +
    '<label class="fld">Weekly balances, 12 comma-separated<input id="in-balances" placeholder="3200, 3250, 3300, ..."></label>' +
    '<label class="fld">Reserve floor<input id="in-floor" type="number" min="0"></label>' +
    '<label class="fld">Forecast source (optional)<input id="in-fsource" maxlength="200" placeholder="e.g. client demo scenario A"></label>' +
    '</div>' +
    '<div class="btns"><button class="act" id="in-submit">Create case</button><button class="act sec" id="in-cancel">Cancel</button></div>';
  document.getElementById('in-cancel').onclick = function(){ state.showIntake = false; render(); };
  document.getElementById('in-submit').onclick = function(){
    var contractId = document.getElementById('in-contract').value.trim();
    var vendor = document.getElementById('in-vendor').value.trim();
    var rawTerms = document.getElementById('in-terms').value.trim();
    var sourceNote = document.getElementById('in-source').value.trim();
    var forecastSource = document.getElementById('in-fsource').value.trim();
    var parts = document.getElementById('in-balances').value.split(',');
    var balances = [];
    for (var i = 0; i < parts.length; i++) { var n = Number(parts[i].trim()); if (parts[i].trim() === '' || !isFinite(n) || n < 0) { toast('Weekly balances must be 12 non-negative numbers'); return; } balances.push(n); }
    var floor = Number(document.getElementById('in-floor').value);
    if (!contractId && (!vendor || !rawTerms || !sourceNote)) { toast('Vendor, terms text and terms source are required'); return; }
    if (balances.length !== 12) { toast('Exactly 12 weekly balances are required'); return; }
    if (!isFinite(floor) || floor < 0) { toast('Reserve floor must be a non-negative number'); return; }
    api(contractId?'/api/salesforce/import':'/api/intake', { contractId:contractId||undefined,confirm:contractId?true:undefined,vendor: vendor, rawTerms: rawTerms, weeklyBalances: balances, reserveFloor: floor, sourceNote: sourceNote, forecastSource: forecastSource || undefined }).then(function(d2){
      if (d2.error) { toast(d2.error); return; }
      state.showIntake = false; state.sel = d2.case.kase.id;
      toast('Case created - terms not extracted yet'); load();
    });
  };
}
function currentForecast(c) { return c.forecast ? c.forecast.weeklyBalances : []; }
document.getElementById('refresh').onclick = function(){ load(); };
document.getElementById('newcase').onclick = function(){ state.showIntake = true; render(); };
document.getElementById('reset').onclick = function(){ if (!confirm('Reset the demo? This clears ALL cases and local state for every case in the queue.')) return; api('/api/reset-demo', {}).then(function(d2){ if (d2 && d2.error) { toast(d2.error); return; } state.sel = null; state.approval = null; load(); }, function(){ toast('Reset outcome unknown: response lost. Refresh before doing anything else.'); }); };
load();
`;
