// Pre-snapshot / pre-push cleanliness gate (review round-5): no tracked runtime artifacts,
// no bare epoch-ms files, no key material, and a clean-ish secret scan of tracked files.
import { execSync } from "node:child_process";

// Works inside a git checkout (tracked files) and in a fresh archive extract (tree walk).
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
let tracked: string[];
let readContent: (f: string) => string;
let inGit = false;
try {
  tracked = execSync("git ls-files", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
  inGit = true;
  readContent = (f) => { try { return execSync(`git show :${JSON.stringify(f)}`, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }); } catch { return ""; } };
} catch {
  // No git metadata (fresh-extract verification): walk the tree, skipping vendored dirs.
  tracked = [];
  const SKIP = new Set(["node_modules", ".git", "dist"]);
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir)) {
      if (SKIP.has(e)) continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full, prefix ? `${prefix}/${e}` : e);
      else tracked.push(prefix ? `${prefix}/${e}` : e);
    }
  };
  walk(".", "");
  readContent = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
}
const bad: string[] = [];

// Packaging guard: every source file on disk must be tracked and not git-ignored, or a
// fresh clone / git archive / format-patch recovery silently drops it. (Found by independent
// recovery review 28 Oct 2026: unanchored console-state* ignored test/console-state.test.ts,
// losing 8 tests.) Only meaningful inside a git checkout; archive extracts have no ignore data.
if (inGit) {
  const trackedSet = new Set(tracked);
  const onDisk: string[] = [];
  const SRC = new Set(["src", "test", "scripts", "evals", "docs"]);
  const walkSrc = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === ".git" || e === "dist") continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walkSrc(full, prefix ? `${prefix}/${e}` : e);
      else onDisk.push(prefix ? `${prefix}/${e}` : e);
    }
  };
  for (const top of readdirSync(".")) {
    if (SRC.has(top) && statSync(top).isDirectory()) walkSrc(top, top);
  }
  for (const f of onDisk) {
    if (!trackedSet.has(f)) bad.push(`source file not tracked by git (lost from clone/archive): ${f}`);
    else {
      try {
        execSync(`git check-ignore -q ${JSON.stringify(f)}`, { stdio: ["ignore", "ignore", "ignore"] });
        bad.push(`source file matched by .gitignore pattern: ${f}`);
      } catch { /* not ignored: good */ }
    }
  }
}

const ARTIFACT = /^[0-9]{13}$|\.(db|sqlite|sqlite-wal|sqlite-shm|db-wal|db-shm|hmac\.key|pem|p12)$|^console-state\.json$|^audit\.jsonl$/;
for (const f of tracked) {
  const base = f.split("/").pop() ?? f;
  if (ARTIFACT.test(base)) bad.push(`tracked artifact: ${f}`);
}
// Secret scan: private keys and provider key shapes in tracked content (excluding docs/examples).
const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{8,}|sk-ant-[A-Za-z0-9-]{8,}/;
for (const f of tracked) {
  if (/\.(png|jpg|jpeg|gif|svg|ico|gz|zip|tar)$/.test(f)) continue;
  const content = readContent(f);
  if (content && SECRET.test(content)) bad.push(`possible secret material in tracked file: ${f}`);
}
if (bad.length) {
  console.error("CLEAN-SOURCE CHECK FAILED:");
  for (const b of bad) console.error(" -", b);
  process.exit(1);
}
console.log(`CLEAN-SOURCE PASS (${tracked.length} files, no artifacts, no secret shapes)`);
