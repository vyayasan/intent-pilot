export const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Intent Pilot - Approval console</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17201e;background:#f4f6f3;font-synthesis:none}
*{box-sizing:border-box}body{margin:0}.shell{max-width:1320px;margin:auto;padding:0 34px 55px}
.top{height:76px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #dfe5e0}
.brand{display:flex;align-items:center;gap:10px;font-weight:750}.mark{width:32px;height:32px;display:grid;place-items:center;border-radius:9px;background:#163d34;color:#fff;font-size:12px}
.intro{padding:38px 0 24px}.eyebrow{margin:0 0 9px;color:#71807a;font-size:10px;font-weight:800;letter-spacing:.12em}
.intro h1{margin:0;font-size:clamp(28px,4vw,40px);letter-spacing:-.045em}.sub{color:#68746f;margin:12px 0 0;font-size:14px}
.layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:22px;align-items:start}
.queue,.card{background:#fff;border:1px solid #e4e9e5;border-radius:14px}
.queue{position:sticky;top:18px;padding:16px 11px}.qhead,.panelhead{display:flex;justify-content:space-between;align-items:center;gap:12px}
.qhead{padding:0 8px 10px}.muted{font-size:11px;color:#89958f}
.casebtn{width:100%;display:grid;gap:5px;text-align:left;padding:12px 10px;border:0;border-radius:10px;background:transparent;cursor:pointer;font:inherit}
.casebtn.on{background:#eef4f1}.casebtn b{font-size:13px}.casebtn span{font-size:11px;color:#68746f}
.panel{padding:26px 28px}.panel h2{margin:0;font-size:22px;letter-spacing:-.03em}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:18px}
.box{border:1px solid #e4e9e5;border-radius:12px;padding:16px}.box h3{margin:0 0 10px;font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#71807a}
.terms{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:#f7f9f7;border-radius:8px;padding:10px;white-space:pre-wrap;color:#39423e}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #edf1ee}th{color:#71807a;font-weight:600;font-size:11px}
.decision{border-left:3px solid #163d34;background:#eef4f1;border-radius:0 10px 10px 0;padding:14px 16px;margin-top:16px}
.decision b{font-size:15px}.reasons{margin:8px 0 0;padding-left:18px;color:#39423e;font-size:13px}.reasons li{margin:4px 0}
.fc{display:flex;gap:4px;align-items:flex-end;height:86px;margin-top:8px;position:relative}.bar{flex:1;background:#cdd9d2;border-radius:3px 3px 0 0;position:relative}
.bar.breach{background:#c05353}.floor{position:absolute;left:0;right:0;border-top:2px dashed #c05353;top:38%}
.btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
button.act{border:0;border-radius:9px;padding:10px 16px;font:inherit;font-size:13px;font-weight:650;cursor:pointer;background:#163d34;color:#fff}
button.sec{background:#eef4f1;color:#163d34}button.warn{background:#f7ecec;color:#8c3a3a}button:disabled{opacity:.4;cursor:not-allowed}
.kv{font-size:12px;color:#39423e;display:grid;grid-template-columns:150px 1fr;row-gap:5px}.kv b{font-weight:600}
.hash{font-family:ui-monospace,Menlo,monospace;font-size:11px;word-break:break-all;color:#68746f}
.txn{display:flex;justify-content:space-between;padding:8px 10px;border-bottom:1px solid #edf1ee;font-size:12.5px}
.ok{color:#1d6b4f;font-weight:650}.bad{color:#a03d3d;font-weight:650}
.audit{margin-top:22px}.audit .row{display:flex;gap:10px;font-size:11.5px;color:#68746f;padding:5px 10px;border-bottom:1px solid #edf1ee}
.audit .row b{color:#39423e;font-weight:600}
.log{font-size:12px;color:#68746f;margin-top:10px}.log div{padding:3px 0}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#163d34;color:#fff;padding:10px 18px;border-radius:9px;font-size:13px;display:none}
</style></head><body>
<div class="shell">
  <div class="top"><div class="brand"><div class="mark">IP</div><div>Intent Pilot</div></div><div class="muted">approval console - sandbox</div></div>
  <div class="intro"><p class="eyebrow">INTENT-BOUND PURCHASE AGENT</p><h1>The card enforces the approved decision.</h1>
  <p class="sub">The agent weighs annual against monthly against the cash forecast. A person approves the intent. The card's controls derive from that approval - change the deal and the card stops matching it.</p></div>
  <div class="layout">
    <div class="queue"><div class="qhead"><p class="eyebrow">QUEUE</p><button class="act sec" id="reset">Reset demo</button></div><div id="cases"></div></div>
    <div class="card panel" id="panel"></div>
  </div>
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
    (c.card ? '<div class="box" style="margin-top:14px"><h3>Card ' + esc(c.card.id.slice(0, 16)) + ' - controls mirror the intent</h3><div class="kv"><b>Limit</b><span>' + c.card.controls.amountLimit + ' per transaction (inclusive)</span><b>Currencies</b><span>' + c.card.controls.currencyAllowlist.join(', ') + '</b><b>Categories</b><span>' + c.card.controls.merchantCategories.join(', ') + '</span><b>Status</b><span>' + c.card.status + '</span></div></div>' : '') +
    '<div class="btns">' +
    (c.intent ? '' : '<button class="act" id="approve">Approve intent</button>') +
    (c.intent && !c.card ? '<button class="act" id="mkcard">Create card</button>' : '') +
    (c.card ? '<button class="act sec" data-sim="in-policy">Simulate: in policy</button><button class="act sec" data-sim="over-cap">Simulate: over cap</button><button class="act sec" data-sim="wrong-currency">Simulate: wrong currency</button><button class="act sec" data-sim="wrong-category">Simulate: wrong category</button>' + (c.card.status === 'ACTIVE' ? '<button class="act warn" id="freeze">Freeze card</button>' : '') : '') +
    (!c.rejected && !c.card ? '<button class="act warn" id="reject">Reject</button>' : '') +
    '</div>' +
    (txns ? '<div class="box" style="margin-top:14px"><h3>Authorizations</h3>' + txns + '</div>' : '') +
    (c.log.length ? '<div class="log">' + c.log.map(function(l){ return '<div>' + esc(l) + '</div>'; }).join('') + '</div>' : '') +
    '<div class="box audit"><h3>Audit trail</h3>' + audit + '</div>';
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
