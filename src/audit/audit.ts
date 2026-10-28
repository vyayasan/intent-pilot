import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";

// Append-only audit trail. Each entry carries the hash of the previous one, so removing or editing
// a line breaks the chain and verifyChain() reports it. Entries never contain keys or tokens.
export interface AuditEntry { seq: number; ts: string; kind: string; caseId?: string; detail: Record<string, unknown>; prev: string; hash: string }

const hashOf = (e: Omit<AuditEntry, "hash">) => createHash("sha256").update(JSON.stringify([e.seq, e.ts, e.kind, e.caseId ?? null, e.detail, e.prev])).digest("hex");

export class AuditLog {
  private entries: AuditEntry[] = [];
  constructor(private file?: string, private now: () => Date = () => new Date()) {
    // Restore the persisted trail so case attribution and the hash chain survive a restart:
    // a fresh log would silently drop the evidence of what happened before the reboot.
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as AuditEntry;
          if (typeof e.seq === "number" && typeof e.hash === "string" && typeof e.prev === "string") this.entries.push(e);
        } catch { /* a corrupt tail line is left for verifyChain/operator review, never silently rewritten */ }
      }
    }
  }
  append(kind: string, detail: Record<string, unknown> = {}, caseId?: string): AuditEntry {
    const prev = this.entries.at(-1)?.hash ?? "genesis";
    const base = { seq: this.entries.length + 1, ts: this.now().toISOString(), kind, caseId, detail, prev };
    const entry: AuditEntry = { ...base, hash: hashOf(base) };
    this.entries.push(entry);
    if (this.file) { appendFileSync(this.file, JSON.stringify(entry) + "\n", { mode: 0o600 }); try { chmodSync(this.file, 0o600); } catch { /* best effort */ } }
    return entry;
  }
  list(): readonly AuditEntry[] { return this.entries; }
}

export function verifyChain(entries: readonly AuditEntry[]): { ok: boolean; brokenAt?: number } {
  let prev = "genesis";
  for (const e of entries) {
    const { hash, ...rest } = e;
    if (e.prev !== prev || hashOf(rest) !== hash) return { ok: false, brokenAt: e.seq };
    prev = hash;
  }
  return { ok: true };
}
