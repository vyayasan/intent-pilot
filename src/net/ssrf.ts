/**
 * SSRF guard for operator-configured outbound endpoints. A literal hostname check is NOT
 * sufficient on its own: DNS can resolve a public-looking name to a private address (and can
 * change between checks). The resolution-time half of this guard therefore runs inside the
 * connect path (undici lookup hook), validating every address the resolver actually returns.
 */

/** True for loopback, private, link-local, CGNAT and local-naming hosts (literal form). */
export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "[::1]") return true;
  const v6 = h.replace(/^\[|\]$/g, "");
  if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return true; // ULA fc00::/7, link-local fe80::/10
  return isPrivateIp(v6);
}

/** "a.b.c.d" or "hex:hex" -> dotted IPv4, else null. */
function dottedOrHexPair(rest: string): string | null {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) return rest;
  const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** Parse an IPv6 literal into eight 16-bit groups, or null when malformed. Handles "::"
 *  compression and a trailing embedded dotted IPv4. A real parser, not regex stacking
 *  (round-3 N4): translation/embedding prefixes are classified on the expanded groups. */
function parseV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  let tail: number[] = [];
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const oct = v4.slice(1).map(Number);
    if (oct.some((n) => n > 255)) return null;
    tail = [(oct[0] << 8) | oct[1], (oct[2] << 8) | oct[3]];
    s = s.slice(0, v4.index);
    // Keep a trailing "::" (it marks compression with an empty right side, e.g. 64:ff9b::8.8.8.8);
    // only strip a single trailing ":" left after the dotted tail (e.g. ::ffff:127.0.0.1).
    if (!s.endsWith("::")) s = s.replace(/:$/, "");
  }
  let parts: string[];
  if (s.includes("::")) {
    if (s.indexOf("::") !== s.lastIndexOf("::")) return null;
    const [l, r] = s.split("::");
    const lg = l ? l.split(":") : [];
    const rg = r ? r.split(":") : [];
    const missing = 8 - lg.length - rg.length - tail.length;
    if (missing < 1) return null;
    parts = [...lg, ...Array(missing).fill("0"), ...rg];
  } else {
    parts = s ? s.split(":") : [];
    if (parts.length + tail.length !== 8) return null;
  }
  const groups = [...parts.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)), ...tail];
  return groups.length === 8 && groups.every((n) => !Number.isNaN(n)) ? groups : null;
}

/** True when a dotted IPv4 literal is loopback/private/link-local/CGNAT/unspecified/reserved. */
function isPrivateV4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Dotted form of the IPv4 embedded in two 16-bit groups. */
const groupsToV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** True when an IP literal is loopback/private/link-local/CGNAT/unspecified - including
 *  IPv4 embedded via mapping (::ffff:), deprecated compat (::/96), NAT64 WKP (64:ff9b::/96,
 *  compressed AND expanded) or 6to4 (2002::/16). Unparseable v6-shaped input fails CLOSED. */
export function isPrivateIp(ip: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return isPrivateV4(ip);
  const g = parseV6(ip);
  if (!g) return ip.includes(":"); // not a v4 literal and not parseable v6: refuse, never wave through
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  if (g.every((n) => n === 0)) return true; // :: unspecified
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return isPrivateV4(groupsToV4(g6, g7)); // IPv4-mapped
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateV4(groupsToV4(g6, g7)); // deprecated IPv4-compatible
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateV4(groupsToV4(g6, g7)); // NAT64 WKP
  if (g0 === 0x2002) return isPrivateV4(groupsToV4(g1, g2)); // 6to4
  return false;
}

/** Throw when any resolved address is private - the connect attempt must not proceed. */
export function assertPublicResolution(hostname: string, addresses: { address: string }[]): void {
  for (const a of addresses) {
    if (isPrivateIp(a.address)) throw new Error(`mail endpoint host ${hostname} resolves to a private/internal address (${a.address}) - refused by SSRF guard`);
  }
}

import { lookup as dnsLookup } from "node:dns";
import { Agent } from "undici";

export type LookupAll = (hostname: string) => Promise<{ address: string; family: number }[]>;

/**
 * An undici dispatcher whose connect-time lookup validates every resolved address: a
 * public-looking hostname that resolves to a private/internal address never gets a connection
 * (DNS-rebinding TOCTOU closed). Use for any outbound fetch to an operator- or
 * discovery-configured endpoint.
 */
export function guardedDispatcher(lookupAll?: LookupAll, mapResolutionError?: (e: Error) => Error): Agent {
  const lookup: LookupAll = lookupAll ?? ((hostname) =>
    new Promise((res, rej) => dnsLookup(hostname, { all: true }, (e, a) => (e ? rej(e) : res(a)))));
  return new Agent({
    connect: {
      lookup: (hostname, opts, cb) => {
        lookup(hostname).then(
          (addrs) => {
            try {
              assertPublicResolution(hostname, addrs);
              // undici's connector invokes the lookup with { all: true } and requires the
              // dns.lookup array form; answering a single (address, family) pair there is
              // misparsed and the connection fails pre-dispatch (ERR_INVALID_IP_ADDRESS).
              if ((opts as { all?: boolean } | undefined)?.all) cb(null, addrs as unknown as string, 0);
              else cb(null, addrs[0].address, addrs[0].family);
            } catch (e) { cb((mapResolutionError ?? ((x: Error) => x))(e as Error), "", 0); }
          },
          (e) => cb(e as Error, "", 0)
        );
      }
    }
  });
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Endpoint URL policy for discovery-configured outbound calls (OIDC endpoints, mail endpoint).
 * Real IdPs legitimately span origins (Google: accounts.google.com / oauth2.googleapis.com /
 * www.googleapis.com), so this does NOT require same-origin - it requires https + no private
 * literal host, and pairs with guardedDispatcher for resolution-time validation. http is
 * accepted only for loopback test issuers.
 */
export function assertPublicEndpoint(raw: string, opts: { allowHttpLoopback?: boolean } = {}): void {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`invalid endpoint URL: ${String(raw).slice(0, 80)}`); }
  if (u.protocol === "https:") {
    if (isPrivateHostname(u.hostname)) throw new Error(`endpoint host is private/internal: ${u.hostname}`);
    return;
  }
  if (u.protocol === "http:" && opts.allowHttpLoopback && LOOPBACK_HOSTS.has(u.hostname)) return;
  throw new Error(`endpoint must be https${opts.allowHttpLoopback ? " (http allowed only for loopback test issuers)" : ""}: ${u.protocol}//${u.hostname}`);
}

export function isLoopbackHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
  } catch { return false; }
}
