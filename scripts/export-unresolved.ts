// Export-before-teardown: preservation of the unresolved authorization locks plus the
// supporting evidence a destructive cleanup would otherwise lose. NOT full fidelity: the
// exclusions below are deliberate, and the artifact is recovery evidence, not a reimportable
// backup (boot restore consumes only `unresolved`). Run BEFORE any state deletion; verify the
// manifest hash; only then tear down.
//
// Guarantees (review round-8):
// - READ-ONLY state access: never takes or disturbs the console's single-writer lease, and
//   leaves no lease behind on exit (round-8 B). Safe to run while a console is live.
// - Shared target resolution with the console server (round-8 C): same state file, engine and
//   audit-file defaults, extension autodetect included.
// - Coherent completeness (round-8 D): unresolved authorization locks (full payloads), the
//   outbox, used approval nonces, the provider cardholder id, and the audit log bytes - one
//   consistent read of the persisted aggregate.
// - Atomic output: tmp+rename, a persisted .sha256 manifest, and a post-write re-read rehash;
//   the tool exits non-zero unless the bytes on disk verify (verify BEFORE delete).
//
// Precision notes (round-9 review):
// - PAIRED CAPTURE NEEDS QUIESCE: state and audit are separate files read at separate instants;
//   under a live writer they can skew. Stop the console (or hold operator actions) when the two
//   must describe the same moment. A live export is safe (read-only) but not a paired snapshot.
// - SAME CWD: the resolved defaults are relative paths; run from the console's working
//   directory or pass absolute INTENTPAY_STATE_FILE / INTENTPAY_AUDIT_FILE.
// - EVIDENCE, NOT REIMPORT: the console's boot restore consumes only `unresolved`. The
//   notifications/usedNonces/holderId/auditJsonl sections are evidence for the operator; they
//   are not imported back into a rebuilt console.
//
// Deliberate exclusions (documented, never silent):
// - approverKey.privateKeyPem: approval-signing material must never leave the state store in a
//   portable artifact. Recovery re-keys the console; outstanding approvals are then invalid,
//   which is fail-closed and intended. The key id (fingerprint) is not needed either.
// - Extraction model prompts/responses: not part of persisted state.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadStateReadOnly, resolveStateTarget, type PersistedState } from "../src/console/state.js";

const { stateFile, stateEngine, auditFile } = resolveStateTarget(process.env);
const out = process.argv[2] ?? `unresolved-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

const loaded = loadStateReadOnly(stateFile, stateEngine);
if (loaded === "corrupted") {
  console.error(`state store at ${stateFile} is corrupted - export refused; resolve the store first (docs/RECOVERY.md)`);
  process.exit(1);
}
const state = loaded as PersistedState | null;

type PendingAuthorization = { requestId: string; cardId: string; reconciledAt?: string; [k: string]: unknown };
const cases = state && Array.isArray(state.cases) ? (state.cases as { kase: { id: string; vendor?: string }; card?: { id?: string; status?: string }; pendingAuthorization?: PendingAuthorization }[]) : [];
const unresolved = cases
  .filter((c) => c?.pendingAuthorization && !c.pendingAuthorization.reconciledAt)
  .map((c) => ({ caseId: c.kase.id, vendor: c.kase.vendor ?? null, cardId: c.card?.id ?? null, cardStatus: c.card?.status ?? null, pendingAuthorization: c.pendingAuthorization }));

let auditJsonl: string | null = null;
let auditReadError: string | null = null;
if (existsSync(auditFile)) {
  try { auditJsonl = readFileSync(auditFile, "utf8"); } catch (e) { auditReadError = (e as Error).message; }
}

const payload = {
  exportedAt: new Date().toISOString(),
  source: { stateFile, stateEngine, auditFile },
  unresolved,
  notifications: state && Array.isArray(state.notifications) ? state.notifications : [],
  // Approval nonces and the cardholder id are preserved as EVIDENCE only: the console never
  // re-imports them (recovery rebuilds them fail-closed - a re-key invalidates outstanding
  // approvals by design). Neither is secret material on its own.
  usedNonces: state?.usedNonces ?? [],
  holderId: state?.holderId ?? null,
  auditJsonl,
  auditReadError,
  exclusions: [
    "approverKey.privateKeyPem (approval signing key: never exported; recovery re-keys, outstanding approvals fail closed)",
    "extraction model prompts/responses (not persisted state)"
  ],
};
const body = JSON.stringify(payload, null, 1);
const sha256 = createHash("sha256").update(body).digest("hex");

// Atomic write: tmp + rename, then a persisted manifest, then re-read and rehash to prove the
// bytes that survived are the bytes we hashed. Any mismatch is a non-zero exit - teardown must
// not proceed on an unverified export.
const tmp = out + ".tmp";
writeFileSync(tmp, body, { mode: 0o600 });
renameSync(tmp, out);
writeFileSync(`${out}.sha256`, `${sha256}  ${out.split("/").pop()}\n`, { mode: 0o600 });
const reread = createHash("sha256").update(readFileSync(out, "utf8")).digest("hex");
if (reread !== sha256) {
  console.error(`export verification FAILED: wrote sha256 ${sha256} but re-read ${reread} - do NOT tear down; investigate storage`);
  process.exit(1);
}
console.log(`exported ${unresolved.length} unresolved authorization(s), ${payload.notifications.length} notification(s), ${payload.usedNonces.length} used nonce(s), audit ${auditJsonl ? auditJsonl.length : 0} bytes${auditReadError ? ` (audit read error: ${auditReadError})` : ""} -> ${out}`);
console.log(`sha256 ${sha256}`);
