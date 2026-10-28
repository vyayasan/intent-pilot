# Recovery runbook

Verified by `npm run drill:crash` (SIGKILL at the two dangerous points) and the store tests.
Golden rule: NEVER blindly retry, and NEVER delete state to "fix" a stuck console on a
live-backed deployment - the state file holds the evidence that prevents duplicate spending.

## 1. Console refuses to boot: "state file is owned by another live console process"

The single-writer lease says another process holds (or recently held) this state file.

1. Confirm whether that process is actually alive (`ps`, container list, supervisor status).
2. Alive: do NOT start a second console against the same state file. Run one.
3. Dead: clear the lease, then boot:
   `node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('console-state.db');db.exec('DELETE FROM lease WHERE id = 1');db.close()"`
   (or `SqliteStore.breakLease(path)` from code). Untouched leases also expire after 30 min.

## 2. Console refuses mutations: "Persisted state is unreadable (fail-closed)" (409 state_corrupted)

The store failed its integrity check or shape validation. Do not delete it.

1. Stop the console. Copy the state file(s) aside (`console-state.db`, `-wal`, `-shm`, or the
   legacy `.json`) - this copy is evidence and may still contain locks/nonces.
2. Restore from backup if one exists (Drive patch backups contain code, not state; state
   backups are an operator duty - see gap register).
3. Simulator/demo only: `/api/reset-demo` is the sanctioned clean start. It is REFUSED on a
   live-backed console precisely because it would erase live locks and evidence.

## 3. Crash between approval consumed and card persisted (drill A)

Symptoms after restart: the case has no card; `POST /api/create-card` with the same approval
answers 409 (nonce already consumed).

1. Check the provider (Airwallex dashboard/API) for a card created with request id
   `<approval.nonce>:card`. The provider's idempotency means ONE card at most.
2. If a card exists: freeze it at the provider, then start a FRESH approval cycle for the case.
   (A console-side case-reset for live mode is a known gap - see PRODUCTION.md G6 follow-ups.)
3. If no card exists: the approval is spent by design (consume-before-call prevents replay);
   start a fresh approval cycle.

## 4. Crash between provider authorization and local persist (drill B)

Symptoms after restart: the case shows an unresolved authorization lock; purchase retries
answer 409 `authorization_unresolved`.

1. Reconcile against the provider's ACTUAL transactions (`/api/reconcile` or the dashboard) -
   the authorization may have committed remotely.
2. Only after the lock is reconciled may the purchase be retried; a reconciled no-match retry
   reuses the SAME request id so the provider deduplicates a silently-committed original.

## 5. What never to do

- Never retry a money-moving call whose outcome is unknown.
- Never run two consoles on one state file (the lease exists to make this loud).
- Never treat a corrupt state file as "start clean" on a live-backed console.
- Never enable INTENTPAY_DRILL_CRASH_AT outside a drill (production config rejects it).
