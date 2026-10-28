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


## 6. Teardown and rebuild: export, restore, orphan resolution (round-8)

Tearing down a VM or wiping a state file without preserving unresolved authorization locks is
how a blind retry becomes a duplicate purchase. The export/restore loop exists so a rebuilt
console comes back ENFORCING those locks, not merely archiving them.

### 6.1 Before ANY destructive cleanup: export and verify

1. QUIESCE FIRST for a paired capture: the state store and the audit log are separate files
   read at separate instants, and under a live writer they can skew (a save between the two
   reads). Stop the console (or hold all operator actions) before exporting when the two must
   describe the same moment. A live export is still safe - read-only, never touches the writer
   lease - it is just not a paired snapshot.
2. Run from the SAME working directory the console runs from, or pass absolute paths:
   `npx tsx scripts/export-unresolved.ts <out.json>`
   State file, engine and audit file resolve exactly as the console resolves them
   (`resolveStateTarget`) - the defaults are RELATIVE (`console-state.db`, `audit.jsonl`), so a
   different CWD silently points the export at different files. Override with
   INTENTPAY_STATE_FILE / INTENTPAY_STATE_ENGINE / INTENTPAY_AUDIT_FILE only when the console
   itself was overridden.
3. The tool writes `<out.json>` atomically (tmp+rename) plus `<out.json>.sha256`, re-reads the
   output and rehashes it, and exits non-zero unless the bytes verify. Do NOT tear down on a
   non-zero exit or a missing manifest - the export is not durable yet.
4. Independently verify: `sha256sum -c <out.json>.sha256` on the COPIED artifact after moving it
   off the machine being destroyed.
5. The export contains: unresolved authorization locks (full payloads), the outbox, used
   approval nonces, the provider cardholder id and the audit log bytes.
   Deliberately excluded: the approver signing key (recovery re-keys; outstanding approvals
   fail closed) and extraction model prompts/responses (not persisted state).
6. A corrupted store REFUSES export (non-zero, no artifact): recover the store FIRST
   (section 2). Orphan resolution is downstream of a readable store + export - you cannot
   resolve what you cannot verifiably preserve, and a corrupt store is never bypassed.

### 6.2 Booting the rebuilt console with the export

1. Boot with `INTENTPAY_UNRESOLVED_RESTORE_FILE=<out.json>`.
2. Locks whose cases survived are re-attached and enforced exactly like live locks: purchases
   refuse 409 `authorization_unresolved` until `/api/reconcile` resolves them. A restored lock
   is never auto-reconciled.
   The export's other sections (notifications, usedNonces, holderId, auditJsonl) are EVIDENCE
   ONLY: the console does not re-import them. Boot restore consumes `unresolved` and nothing
   else - nonces and the cardholder id come from the live state file or are rebuilt fail-closed
   (a re-key invalidates outstanding approvals by design).
3. An unreadable restore file fails CLOSED like corrupt state (409 `state_corrupted` on
   mutations): fix the file or remove the env - never boot past it.

### 6.3 Orphans and conflicts: the global purchase gate

A preserved lock whose case did NOT survive (orphan), or that conflicts with a DIFFERENT live
lock on its case (conflict), cannot be enforced case-locally. Both are surfaced in
`/api/cases` as `restoredUnresolved` (with `kind` and, for conflicts, `keptRequestId`) and BOTH
gate every new-purchase path (`/api/approve`, `/api/create-card`, `/api/simulate`,
`/api/change-terms`) with 409 `orphan_authorization_unresolved` until each is resolved.

- Never "fix" an orphan by pointing it at a same-vendor case: vendor is not identity.
- Resolve each entry explicitly, with provider evidence, as an approver:
  `POST /api/resolve-restored` with `{ caseId, requestId, resolution, evidence, operatorToken }`
  - resolution: `no_matching_transaction` | `transaction_recorded` | `duplicate_confirmed_frozen`
  - evidence: what the operator actually inspected (dashboard search, ledger listing, provider
    ticket), min 8 chars. Like reconcile's manualConfirm this is a LOCAL attestation, never
    proof of provider finality.
  - Requires INTENTPAY_OPERATOR_TOKEN; without it resolution is unavailable (403), never open.
- Resolutions are audited (`restored_orphan_resolved`) but deliberately NOT persisted: a later
  boot pointed at the same stale export re-raises the entry (fail-closed). The mirror image is
  the operational requirement: the gate exists ONLY while the console boots WITH the restore
  file. Dropping INTENTPAY_UNRESOLVED_RESTORE_FILE (or rebooting without it) silently removes
  the gate - until a persisted mechanism lands, KEEP the restore file configured on every boot
  from the first restore until every entry is resolved, and only then retire it.
- The evidence field is an operator attestation, not verified provider evidence and never
  cryptographic resolution: the 8-character minimum is a shape check only, and the operator
  token gates WHO may resolve, not WHAT is true. Finality still comes only from the provider.
- Simulator only: `/api/reset-demo` clears orphans with the rest of the demo state. On a
  live-backed console reset stays refused, orphans included.

## 5. What never to do

- Never retry a money-moving call whose outcome is unknown.
- Never run two consoles on one state file (the lease exists to make this loud).
- Never treat a corrupt state file as "start clean" on a live-backed console.
- Never enable INTENTPAY_DRILL_CRASH_AT outside a drill (production config rejects it).
- Never delete state before an export verifies (section 6.1).
- Never treat an export as reconciliation: restoring locks is enforcement, not resolution.
