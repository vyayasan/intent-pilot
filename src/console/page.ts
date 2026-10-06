export const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IntentPay - Approval console</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap">
<style>
:root{font-family:Poppins,Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#101828;background:#fcfcfd;font-synthesis:none}
*{box-sizing:border-box}body{margin:0;font-size:14px}
.strip{background:#f2f4f7;color:#475467;font-size:12px;text-align:center;padding:8px 12px}
.wrap{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:calc(100vh - 33px);align-items:start}
.side{background:#14171a;color:#e6eaee;display:flex;flex-direction:column;padding:14px 12px;position:sticky;top:0;min-height:100vh}
.org{display:flex;gap:10px;align-items:center;padding:6px 8px 14px;border-bottom:1px solid #23282d;margin-bottom:6px}
.orgmark{width:34px;height:34px;border-radius:50%;background:#e04d37;color:#fff;display:grid;place-items:center;font-weight:600;font-size:12px}
.orgt strong{font-size:14px;display:block;font-weight:600;color:#fff}.orgt span{font-size:11px;color:#9ba3ab}
.navhead{font-size:10px;letter-spacing:.09em;color:#8a939c;margin:16px 8px 6px;text-transform:uppercase;font-weight:600}
.navitem{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;font-size:13px;color:#e6eaee}
.navitem.active{color:#e04d37;background:#1e2226;font-weight:500;box-shadow:inset 3px 0 #e04d37}
.casebtn{display:block;width:100%;text-align:left;background:transparent;border:0;padding:9px 12px;border-radius:8px;cursor:pointer;color:#e6eaee;font:inherit}
.casebtn:hover{background:#1e2226}.casebtn.on{background:#1e2226;box-shadow:inset 3px 0 #e04d37}
.casebtn b{color:#fff;font-size:13px;font-weight:600;display:block}
.casebtn span{color:#8a939c;font-size:10px;text-transform:capitalize}
.casebtn.on span{color:#e04d37}
.sidefoot{margin-top:auto;padding:12px 8px 4px;color:#6b747d;font-size:10px;border-top:1px solid #23282d}
.qrow{display:flex;justify-content:space-between;align-items:center;margin-top:16px}
.qrow .navhead{margin:0 8px}
.content{padding:22px 34px 60px;min-width:0}
.muted{font-size:11px;color:#98a2b3}
.panelhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.panelhead h2{margin:0;font-size:22px;font-weight:600;letter-spacing:-.01em}
.grid2{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(260px,.95fr);gap:16px}
.box{background:#fff;border:1px solid #e4e7ea;border-radius:12px;padding:20px}
.box h3{margin:0 0 10px;font-size:13px;font-weight:600;color:#101828;text-transform:none}
.terms{background:#f9fafb;border:1px solid #e4e7ea;border-radius:8px;padding:12px;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#344054;line-height:1.55;white-space:pre-wrap}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
th{color:#667085;font-size:10px;text-transform:uppercase;letter-spacing:.06em;text-align:left;padding:6px 8px;border-bottom:1px solid #e4e7ea;font-weight:600}
td{padding:8px;border-bottom:1px solid #f0f2f3;color:#101828}
.fc{position:relative;display:flex;align-items:flex-end;gap:6px;height:90px;border-bottom:1px solid #e4e7ea;padding-bottom:2px}
.bar{flex:1;background:#d9d0fb;border-radius:2px 2px 0 0}
.bar.breach{background:#e04d37}
.floor{position:absolute;left:0;right:0;border-top:2px dashed #c05353}
.decision{margin-top:16px;background:#f9fafb;border:1px solid #e4e7ea;border-radius:10px;padding:14px 16px}
.decision b{font-size:13px;color:#101828}
.reasons{margin:8px 0 0;padding-left:18px;color:#475467;font-size:12.5px;line-height:1.6}
.kv{font-size:12.5px;display:grid;grid-template-columns:150px 1fr;row-gap:6px;margin-top:6px}
.kv b{font-weight:500;color:#667085}.kv span{color:#101828}
.hash{font-family:ui-monospace,Menlo,monospace;font-size:11px;word-break:break-all;color:#98a2b3;margin-top:10px}
.btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
button.act{border:1px solid transparent;border-radius:8px;padding:10px 18px;font:500 13px Poppins,Inter,ui-sans-serif,sans-serif;cursor:pointer;background:#612fef;color:#fff}
button.act:hover{background:#5319e0}
button.sec{background:#fff;color:#344054;border-color:#d0d5dd}
button.sec:hover{background:#f9fafb}
button.warn{background:#fff;color:#b42318;border-color:#fecdca}
button.warn:hover{background:#fef3f2}
button:disabled{opacity:.5;cursor:not-allowed}
.txn{display:flex;justify-content:space-between;padding:9px 4px;border-bottom:1px solid #f0f2f3;font-size:12.5px;color:#344054}
.ok{color:#027a48;font-weight:600}.bad{color:#b42318;font-weight:600}
.audit{margin-top:16px;background:#fff;border:1px solid #e4e7ea;border-radius:12px;padding:20px}
.audit h3{margin:0 0 8px;font-size:13px;font-weight:600}
.audit .row{display:flex;gap:10px;font-size:11px;color:#667085;padding:5px 4px;border-bottom:1px solid #f0f2f3}
.audit .row b{color:#344054;font-weight:600}
.log{font-size:12px;color:#667085;margin-top:12px}.log div{padding:3px 0}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#101828;color:#fff;padding:11px 20px;border-radius:8px;font-size:13px;display:none;box-shadow:0 4px 14px rgba(16,24,40,.25)}
@media(max-width:900px){.wrap{grid-template-columns:1fr}.side{position:static;min-height:0}.content{padding:18px}.grid2{grid-template-columns:1fr}}
</style></head><body>
<div class="strip">IntentPay console · running live against the Airwallex sandbox</div>
<div class="wrap">
  <aside class="side">
    <div class="org"><span class="orgmark">IP</span><div class="orgt"><strong>IntentPay</strong><span>Intent-bound purchase agent</span></div></div>
    <p class="navhead">Issuing</p>
    <div class="navitem active">Purchase intents</div>
    <div class="qrow"><p class="navhead">Queue</p><button class="act sec" id="reset" style="padding:5px 10px;font-size:11px">Reset demo</button></div>
    <div id="cases"></div>
    <div class="sidefoot">Connected to the Airwallex sandbox API</div>
  </aside>
  <main class="content"><div id="panel"></div></main>
</div>
<div class="toast" id="toast"></div>
<script>
var token = document.querySelector('meta[name="console-token"]').content;
var state = { cases: [], audit: [], sel: null, approval: null };
function api(path, body) {
  return fetch(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-console-token': token }, body: body ? JSON.stringify(body) : undefined }).then(function(r){ return r.json(); });
}
function toast(msg) { var t = document.getElementById('toast'); t.textContent = msg; t.style.display = 'block'; setTimeout(function(){ t.style.display = 'none'; }, 3200); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]; }); }
function load() { return api('/api/cases').then(function(d){ state.cases = d.cases; state.audit = d.audit; if (!state.sel && d.cases.length) state.sel = d.cases[0].kase.id; render(); }); }
function current() { return state.cases.filter(function(c){ return c.kase.id === state.sel; })[0]; }
function render() {
  var q = document.getElementById('cases');
  q.innerHTML = state.cases.map(function(c){
    var stage = c.card ? 'card live' : (c.intent ? 'approved' : (c.rejected ? 'rejected' : 'awaiting review'));
    return '<button class="casebtn' + (c.kase.id === state.sel ? ' on' : '') + '" data-id="' + esc(c.kase.id) + '"><b>' + esc(c.kase.vendor) + '</b><span>' + stage + '</span></button>';
  }).join('');
  Array.prototype.forEach.call(q.querySelectorAll('.casebtn'), function(b){ b.onclick = function(){ state.sel = b.dataset.id; state.approval = null; render(); }; });
  var c = current(); var p = document.getElementById('panel');
  if (!c) { p.innerHTML = '<p class="muted">No cases.</p>'; return; }
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
  var audit = state.audit.slice(-8).map(function(a){ return '<div class="row"><b>' + esc(a.kind) + '</b><span>' + esc(JSON.stringify(a.detail).slice(0, 120)) + '</span></div>'; }).join('');
  p.innerHTML =
    '<div class="panelhead"><h2>' + esc(f.vendor) + '</h2><span class="muted">' + esc(f.id) + '</span></div>' +
    '<div class="grid2"><div class="box"><h3>Vendor terms (untrusted text)</h3><div class="terms">' + esc(f.rawTerms) + '</div>' +
    (t ? '<table><tr><th></th><th>Monthly</th><th>Annual</th></tr><tr><td>Price</td><td>' + t.monthlyPrice + ' ' + t.currency + '/mo</td><td>' + t.annualPrice + ' ' + t.currency + '/yr</td></tr><tr><td>12-month total</td><td>' + (t.monthlyPrice * 12) + '</td><td>' + t.annualPrice + ' (saves ' + (d.savingsPct || 0) + '%)</td></tr><tr><td>Notice</td><td colspan="2">' + (t.noticeDays || 0) + ' days</td></tr></table>' : '') +
    '</div><div class="box"><h3>Cash forecast vs reserve floor</h3><div class="fc">' + bars + '<div class="floor" style="top:' + (86 - Math.round(70 * (c.forecast.reserveFloor / (maxB || 1)))) + 'px"></div></div><div class="muted" style="margin-top:6px">Reserve floor ' + c.forecast.reserveFloor + '. Red bar: the week annual billing breaches it.</div></div></div>' +
    '<div class="decision"><b>Policy decision: ' + d.cadence.toUpperCase() + '</b><ul class="reasons">' + d.reasons.map(function(r){ return '<li>' + esc(r) + '</li>'; }).join('') + '</ul></div>' +
    (c.intent ? '<div class="box" style="margin-top:14px"><h3>Approved intent</h3><div class="kv"><b>Cadence</b><span>' + c.intent.cadence + '</span><b>Cap</b><span>' + c.intent.amountCap + ' ' + c.intent.currency + ' per transaction</span><b>Categories</b><span>' + c.intent.categories.join(', ') + '</span><b>Reconsider</b><span>' + (c.intent.reconsiderAt || 'at renewal') + '</span></div><div class="hash">terms ' + c.intent.termsHash + '</div></div>' : '') +
    (c.card ? '<div class="box" style="margin-top:14px"><h3>Card ' + esc(c.card.id.slice(0, 16)) + ' - controls mirror the intent</h3><div class="kv"><b>Limit</b><span>' + c.card.controls.amountLimit + ' per transaction (inclusive)</span><b>Currencies</b><span>' + c.card.controls.currencyAllowlist.join(', ') + '</span><b>Categories</b><span>' + c.card.controls.merchantCategories.join(', ') + '</span><b>Status</b><span>' + c.card.status + '</span></div></div>' : '') +
    '<div class="btns">' +
    (!c.intent && !c.card ? '<button class="act sec" id="extract">Extract terms (model)</button>' : '') +
    (c.intent ? '' : '<button class="act" id="approve">Approve intent</button>') +
    (c.intent && !c.card ? '<button class="act" id="mkcard">Create card</button>' : '') +
    (c.card ? '<button class="act sec" data-sim="in-policy">Simulate: in policy</button><button class="act sec" data-sim="over-cap">Simulate: over cap</button><button class="act sec" data-sim="wrong-currency">Simulate: wrong currency</button><button class="act sec" data-sim="wrong-category">Simulate: wrong category</button>' + (c.card.status === 'ACTIVE' ? '<button class="act warn" id="freeze">Freeze card</button>' : '') : '') +
    (!c.rejected && !c.card ? '<button class="act warn" id="reject">Reject</button>' : '') +
    '</div>' +
    (txns ? '<div class="box" style="margin-top:14px"><h3>Authorizations</h3>' + txns + '</div>' : '') +
    (c.log.length ? '<div class="log">' + c.log.map(function(l){ return '<div>' + esc(l) + '</div>'; }).join('') + '</div>' : '') +
    '<div class="box audit"><h3>Audit trail</h3>' + audit + '</div>';
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
  Array.prototype.forEach.call(p.querySelectorAll('[data-sim]'), function(b){ b.onclick = function(){ api('/api/simulate', { caseId: c.kase.id, kind: b.dataset.sim }).then(function(d2){ if (d2.error) { toast(d2.error); return; } var t = d2.transaction; toast(t.status === 'CLEARING' ? 'Cleared: ' + t.amount + ' ' + t.currency : 'Declined: ' + t.failureReason + ' - the card enforced the intent'); load(); }); }; });
  var fr = document.getElementById('freeze');
  if (fr) fr.onclick = function(){ api('/api/freeze', { caseId: c.kase.id }).then(function(){ toast('Card frozen'); load(); }); };
  var rj = document.getElementById('reject');
  if (rj) rj.onclick = function(){ var reason = prompt('Why are you rejecting this purchase?'); if (!reason) return; api('/api/reject', { caseId: c.kase.id, reason: reason }).then(function(){ toast('Rejected - no card was created'); load(); }); };
}
function currentForecast(c) { return c.forecast ? c.forecast.weeklyBalances : []; }
document.getElementById('reset').onclick = function(){ api('/api/reset-demo', {}).then(function(){ state.sel = null; state.approval = null; load(); }); };
load();
</script></body></html>`;
