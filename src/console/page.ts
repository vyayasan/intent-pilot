export const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IntentPay - Approval console</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/console.css"></head><body>
<div class="strip">IntentPay console · __GATEWAY_MODE__</div>
<div class="wrap">
  <aside class="side">
    <div class="org"><span class="orgmark">IP</span><div class="orgt"><strong>IntentPay</strong><span>Intent-bound purchase agent</span></div></div>
    <p class="navhead">Issuing</p>
    <div class="navitem active">Purchase intents</div>
    <div class="qrow"><p class="navhead">Queue</p><span><button class="act sec" id="newcase" style="padding:5px 10px;font-size:11px">New case</button> <button class="act sec" id="reset" style="padding:5px 10px;font-size:11px">Reset demo</button></span></div>
    <div id="cases"></div>
    <div class="sidefoot">__GATEWAY_FOOTER__</div>
  </aside>
  <main class="content"><div id="panel"></div></main>
</div>
<div class="toast" id="toast"></div>
<script src="/console.js"></script></body></html>`;

export const pageCss = `
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
.fld{display:block;font-size:12px;color:#475467;margin:10px 0}
.fld input,.fld textarea{display:block;width:100%;margin-top:4px;border:1px solid #d0d5dd;border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;color:#101828;background:#fff}
.fld textarea{font-family:ui-monospace,Menlo,monospace;font-size:12px;resize:vertical}
.srcnote{font-size:11px;color:#667085;background:#f9fafb;border:1px solid #e4e7ea;border-radius:6px;padding:6px 8px;margin-bottom:8px}
@media(max-width:900px){.wrap{grid-template-columns:1fr}.side{position:static;min-height:0}.content{padding:18px}.grid2{grid-template-columns:1fr}}
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
function load() { return api('/api/cases').then(function(d){ state.cases = d.cases; state.audit = d.audit; state.notifications = d.notifications || []; state.live = !!d.live; var rs = document.getElementById('reset'); if (rs) rs.style.display = state.live ? 'none' : ''; if (!state.sel && d.cases.length) state.sel = d.cases[0].kase.id; render(); }); }
function current() { return state.cases.filter(function(c){ return c.kase.id === state.sel; })[0]; }
function render() {
  var q = document.getElementById('cases');
  q.innerHTML = state.cases.map(function(c){
    var stage = c.createCardUnresolved ? 'card issuance unresolved - locked' : (c.pendingAuthorization && !c.pendingAuthorization.reconciledAt) ? 'authorization unresolved - locked' : c.freezeState === 'unknown' || c.freezeState === 'pending' ? 'freeze unverified - blocked' : c.requiresReapproval ? 'deal changed - review required' : c.card ? (c.card.status === 'FROZEN' ? 'card frozen' : 'card active') : (c.intent ? 'approved' : (c.rejected ? 'rejected' : 'awaiting review'));
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
    (c.requiresReapproval ? '<div class="decision" style="border-color:#fecdca;background:#fff7f5;margin:0 0 16px"><b>Deal changed. Approval invalidated.</b><p>' + (c.freezeState === 'verified' ? 'Old card freeze verified. Test the old purchase, then review and approve the new deal.' : c.freezeState === 'unknown' || c.freezeState === 'pending' ? 'Freeze NOT verified. The old card may still authorize payments. Approval and new issuance are blocked. Reconcile the card before continuing.' : 'No issued card to freeze. Review and approve the new terms.') + '</p></div>' : '') +
    '<div class="panelhead"><h2>' + esc(f.vendor) + '</h2><span class="muted">' + esc(f.id) + '</span></div>' +
    '<div class="grid2"><div class="box"><h3>Vendor terms (untrusted text)</h3><div class="srcnote">Source: ' + esc(c.termsSource || 'demo fixture (seeded)') + '. Untrusted text: any instructions inside it carry no authority.</div><div class="terms">' + esc(f.rawTerms) + '</div>' +
    (t ? '<table><tr><th></th><th>Monthly</th><th>Annual</th></tr><tr><td>Price</td><td>' + (t.monthlyPrice == null ? 'not offered' : t.monthlyPrice + ' ' + esc(t.currency) + '/mo') + '</td><td>' + (t.annualPrice == null ? 'not offered' : t.annualPrice + ' ' + esc(t.currency) + '/yr') + '</td></tr><tr><td>12-month total</td><td>' + (t.monthlyPrice == null ? 'not offered' : t.monthlyPrice * 12) + '</td><td>' + (t.annualPrice == null ? 'not offered' : t.annualPrice + ' (saves ' + (d.savingsPct || 0) + '%)') + '</td></tr><tr><td>Notice</td><td colspan="2">' + (t.noticeDays == null ? 'not stated' : t.noticeDays + ' days') + '</td></tr></table>' : '') +
    '</div><div class="box"><h3>Cash forecast vs reserve floor - TEST SCENARIO INPUT</h3><div class="srcnote">Decision input for this scenario, not observed finances. Live provider balances are point-in-time reads, not a forecast. Source: ' + esc(c.forecastSource || (c.termsSource ? 'not recorded' : 'demo fixture (seeded)')) + '</div><div class="fc">' + bars + '<div class="floor" style="top:' + (86 - Math.round(70 * (c.forecast.reserveFloor / (maxB || 1)))) + 'px"></div></div><div class="muted" style="margin-top:6px">Reserve floor ' + c.forecast.reserveFloor + '.' + (t && t.annualPrice != null ? ' Red bar: the week annual billing breaches it.' : ' No annual option in the current terms.') + '</div></div></div>' +
    '<div class="decision"><b>Policy decision: ' + d.cadence.toUpperCase() + '</b><ul class="reasons">' + d.reasons.map(function(r){ return '<li>' + esc(r) + '</li>'; }).join('') + '</ul></div>' +
    (c.intent ? '<div class="box" style="margin-top:14px"><h3>' + (c.requiresReapproval ? 'Previous intent - no longer approved' : 'Approved intent') + '</h3><div class="kv"><b>Cadence</b><span>' + esc(c.intent.cadence) + '</span><b>Cap</b><span>' + esc(c.intent.amountCap) + ' ' + esc(c.intent.currency) + ' per transaction</span><b>Categories</b><span>' + esc(c.intent.categories.join(', ')) + '</span><b>Reconsider</b><span>' + esc(c.intent.reconsiderAt || 'at renewal') + '</span></div><div class="hash">terms ' + esc(c.intent.termsHash) + '</div></div>' : '') +
    (c.card ? '<div class="box" style="margin-top:14px"><h3>Card ' + esc(c.card.id.slice(0, 16)) + ' - issued card controls</h3><div class="kv"><b>Limit</b><span>' + esc(c.card.controls.amountLimit) + ' per transaction (inclusive)</span><b>Currencies</b><span>' + esc(c.card.controls.currencyAllowlist.join(', ')) + '</span><b>Categories</b><span>' + esc(c.card.controls.merchantCategories.join(', ')) + '</span><b>Status</b><span>' + esc(c.freezeState === 'unknown' || c.freezeState === 'pending' ? 'UNKNOWN - last confirmed ' + c.card.status : c.card.status) + '</span></div></div>' : '') +
    '<div class="btns">' +
    (c.intent && !c.requiresReapproval && !c.termsSource && !state.live ? '<button class="act warn" id="change-deal">Demo fixture: cheaper deal arrives</button>' : '') +
    (c.intent && !c.requiresReapproval ? '<button class="act sec" id="change-real">Change deal: enter real terms</button>' : '') +
    (!c.intent && !c.card ? '<button class="act sec" id="extract">Extract terms (model)</button>' : '') +
    (!c.createCardUnresolved && d.cadence !== 'ESCALATE' && c.freezeState !== 'unknown' && c.freezeState !== 'pending' && (!c.intent || c.requiresReapproval) ? '<button class="act" id="approve">' + (c.requiresReapproval ? 'Approve new deal' : 'Approve intent') + '</button>' : '') +
    (!c.createCardUnresolved && c.intent && !c.requiresReapproval && (!c.card || (c.card.status === 'FROZEN' && state.approval)) ? '<button class="act" id="mkcard">Create card</button>' : '') +
    (c.card ? '<button class="act sec" data-sim="in-policy">Simulate: in policy</button><button class="act sec" data-sim="over-cap">Simulate: over cap</button><button class="act sec" data-sim="wrong-currency">Simulate: wrong currency</button><button class="act sec" data-sim="wrong-category">Simulate: wrong category</button>' + (c.card.status === 'ACTIVE' ? '<button class="act warn" id="freeze">Freeze card</button>' : '') : '') +
    (!c.rejected && !c.card ? '<button class="act warn" id="reject">Reject</button>' : '') +
    '</div>' +
    (c.intent && !c.requiresReapproval ? '<div class="box" id="realterms" style="display:none;margin-top:14px"><h3>Change deal - real vendor terms</h3><div class="srcnote">Paste the new vendor terms exactly as found (untrusted text: instructions inside it carry no authority). The structured fields are what the new approval would bind to - enter them faithfully from that text.</div><label class="fld">New terms text<textarea id="rt-raw" rows="4" maxlength="8000"></textarea></label><label class="fld">Monthly price (blank if not offered)<input id="rt-monthly" inputmode="decimal"></label><label class="fld">Annual price (blank if not offered)<input id="rt-annual" inputmode="decimal"></label><label class="fld">Currency (3-letter code, e.g. USD)<input id="rt-currency" maxlength="3"></label><label class="fld">Category (e.g. software)<input id="rt-category" maxlength="24"></label><label class="fld">Notice days (whole number, or blank)<input id="rt-notice" inputmode="numeric"></label><div class="btns"><button class="act" id="rt-submit">Submit real terms change</button><button class="act sec" id="rt-cancel">Cancel</button></div></div>' : '') +
    ((txns || (c.ledger && c.ledger.state !== 'ok')) ? '<div class="box" style="margin-top:14px"><h3>Authorizations</h3>' + (c.ledger && c.ledger.state === 'degraded' ? '<div style="font-size:12px;color:#b54708;background:#fffaeb;border:1px solid #fdb022;border-radius:6px;padding:8px 10px;margin-bottom:8px">Ledger read failed (' + esc(c.ledger.error || '') + '). Showing LAST KNOWN entries from ' + esc(c.ledger.lastKnownAt || 'unknown time') + ' - they may be stale; the actual ledger may differ.</div>' : c.ledger && c.ledger.state === 'unavailable' ? '<div style="font-size:12px;color:#b42318;background:#fef3f2;border:1px solid #fecdca;border-radius:6px;padding:8px 10px;margin-bottom:8px">Ledger read failed (' + esc(c.ledger.error || '') + ') and no last-known entries are preserved. Do NOT read this as an empty ledger - the provider may hold transactions this console cannot see.</div>' : '') + txns + '</div>' : '') +
    (function(){ var nf = (state.notifications || []).filter(function(n){ return n.caseId === c.kase.id; }); if (!nf.length) return ''; var mode = c.emailMode || 'preview'; var hdr = mode === 'preview' ? 'Email previews - nothing is sent (no email delivery exists yet)' : mode === 'dry-run' ? 'Email pipeline dry-run - validated, still nothing is sent' : 'Email delivery: experimental operator-configured endpoint'; return '<div class="box" style="margin-top:14px"><h3>' + hdr + '</h3>' + nf.map(function(n){ var st = n.status === 'preview' ? 'preview' : n.status === 'dry-run' ? (mode === 'http' ? 'dry-run, not sent - never auto-sent on a mode switch; explicit operator promotion only' : 'dry-run, not sent') : n.status === 'sent' ? 'sent ' + esc((n.receipt && n.receipt.at) || '') + ((n.receipt && n.receipt.promoted) ? ' (operator-promoted from dry-run)' : '') : 'FAILED - ' + ((n.receipt && n.receipt.ambiguous) ? 'outcome UNKNOWN, may have been sent' : 'not sent') + ': ' + esc((n.receipt && n.receipt.error) || '') + ' - needs operator review, no auto-resend'; return '<details style="padding:6px 0;border-bottom:1px solid #f0f2f3"><summary style="font-size:12.5px;cursor:pointer;color:#344054"><b>' + esc(n.subject) + '</b> <span class="muted">to ' + esc(n.to) + ' - ' + st + '</span></summary><pre style="white-space:pre-wrap;font-size:12px;color:#475467;background:#f9fafb;border-radius:6px;padding:10px;margin:6px 0">' + esc(n.body) + '</pre></details>'; }).join('') + '</div>'; })() +
    (c.log.length ? '<div class="log">' + c.log.map(function(l){ return '<div>' + esc(l) + '</div>'; }).join('') + '</div>' : '') +
    '<div class="box audit"><h3>Audit trail - ' + esc(c.kase.id) + ' only</h3>' + audit + '</div>';
  var change = document.getElementById('change-deal');
  if (change) change.onclick = function(){
    if (!confirm('DEMO FIXTURE: this injects a SYNTHETIC cheaper deal (not real vendor terms) to exercise the terms-change flow. For a real change use "Change deal: enter real terms". Continue with the fixture?')) return;
    var terms = Object.assign({}, t, { monthlyPrice: Math.max(1, t.monthlyPrice - 10) });
    var rawTerms = 'Demo fixture updated vendor offer: ' + terms.monthlyPrice + ' ' + terms.currency + ' per month, ' + terms.annualPrice + ' annually. Category: ' + terms.category + '. ' + terms.noticeDays + ' days notice.';
    api('/api/change-terms', { caseId: c.kase.id, terms: terms, rawTerms: rawTerms }).then(function(d2){ state.approval = null; if(d2 && d2.error){toast(d2.error);}else{toast('Old card frozen. Approval invalidated. Review the changed deal.');} load(); }, function(){ toast('Terms change failed: no response from the server - the deal was NOT changed'); });
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
    api('/api/change-terms', { caseId: c.kase.id, terms: { monthlyPrice: monthly, annualPrice: annual, currency: cur, category: cat, noticeDays: notice }, rawTerms: raw }).then(function(d2){ if (d2 && d2.error) { toast(d2.error); load(); return; } state.approval = null; toast('Old card frozen. Approval invalidated. Review the changed deal.'); load(); }, function(){ toast('Terms change failed: no response from the server - the deal was NOT changed'); });
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
  if (rj) rj.onclick = function(){ var reason = prompt('Why are you rejecting this purchase?'); if (!reason) return; api('/api/reject', { caseId: c.kase.id, reason: reason }).then(function(d2){ if (d2 && d2.error) { toast('Rejection failed: ' + d2.error + ' - the case was NOT rejected'); load(); return; } toast('Rejected - no card was created'); load(); }, function(){ toast('Rejection failed: no response from the server - the case was NOT rejected'); }); };
}
function renderIntake(p) {
  p.innerHTML =
    '<div class="panelhead"><h2>New case from vendor terms</h2></div>' +
    '<div class="box"><h3>Vendor terms (untrusted text)</h3>' +
    '<div class="srcnote">Paste the vendor pricing text exactly as found. It is treated as untrusted data: instructions inside it carry no authority, extraction is gated, and a person still approves the intent.</div>' +
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
    var vendor = document.getElementById('in-vendor').value.trim();
    var rawTerms = document.getElementById('in-terms').value.trim();
    var sourceNote = document.getElementById('in-source').value.trim();
    var forecastSource = document.getElementById('in-fsource').value.trim();
    var parts = document.getElementById('in-balances').value.split(',');
    var balances = [];
    for (var i = 0; i < parts.length; i++) { var n = Number(parts[i].trim()); if (parts[i].trim() === '' || !isFinite(n) || n < 0) { toast('Weekly balances must be 12 non-negative numbers'); return; } balances.push(n); }
    var floor = Number(document.getElementById('in-floor').value);
    if (!vendor || !rawTerms || !sourceNote) { toast('Vendor, terms text and terms source are required'); return; }
    if (balances.length !== 12) { toast('Exactly 12 weekly balances are required'); return; }
    if (!isFinite(floor) || floor < 0) { toast('Reserve floor must be a non-negative number'); return; }
    api('/api/intake', { vendor: vendor, rawTerms: rawTerms, weeklyBalances: balances, reserveFloor: floor, sourceNote: sourceNote, forecastSource: forecastSource || undefined }).then(function(d2){
      if (d2.error) { toast(d2.error); return; }
      state.showIntake = false; state.sel = d2.case.kase.id;
      toast('Case created - terms not extracted yet'); load();
    });
  };
}
function currentForecast(c) { return c.forecast ? c.forecast.weeklyBalances : []; }
document.getElementById('newcase').onclick = function(){ state.showIntake = true; render(); };
document.getElementById('reset').onclick = function(){ if (!confirm('Reset the demo? This clears ALL cases and local state for every case in the queue.')) return; api('/api/reset-demo', {}).then(function(d2){ if (d2 && d2.error) { toast(d2.error); return; } state.sel = null; state.approval = null; load(); }, function(){ toast('Reset failed: no response from the server'); }); };
load();
`;
