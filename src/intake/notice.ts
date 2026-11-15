import { createHash, randomUUID } from 'node:crypto';
import type { Terms } from '../domain/types.js';
import type { PlanResult } from '../agent/planner.js';
import type { CadenceDecision } from '../policy/policy.js';
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export interface NoticeProposal {
  id: string; baseVersion: string; source: { filename: string; sha256: string; sender?: string; subject?: string; trust: string };
  rawTerms: string; status: 'review' | 'blocked' | 'no-change' | 'applying' | 'applied'; at: string; expiresAt: string;
  rationale: string; citations: string[]; changes: { field: string; before: unknown; after: unknown }[];
  terms?: Terms; decision?: CadenceDecision; missingFields?: string[];
}
/** File headers record provenance, not authentication. No links are followed and HTML is never rendered. */
export function parseNotice(filename: string, content: string) {
  if (content.length > 8000 || !content.trim() || /\x00/.test(content)) throw Error('Notice must contain 1-8000 text characters');
  if (!/\.(txt|eml)$/i.test(filename)) throw Error('Use a plain-text .txt or .eml notice; PDF and HTML are not supported');
  let text = content, sender: string | undefined, subject: string | undefined;
  if (/\.eml$/i.test(filename)) {
    const boundary = content.search(/\r?\n\r?\n/);
    if (boundary < 0) throw Error('Email needs headers and a plain-text body');
    const headers = content.slice(0, boundary).replace(/\r?\n[ \t]+/g, ' ');
    const header = (name: string) => headers.match(new RegExp('^' + name + ':\\s*(.*)$', 'im'))?.[1]?.trim();
    const type = header('content-type');
    if (type && !/^text\/plain(?:;|$)/i.test(type)) throw Error('Only plain-text email supported; export a text copy for multipart/HTML');
    const encoding = header('content-transfer-encoding');
    if (encoding && !/^(7bit|8bit|binary)$/i.test(encoding)) throw Error('Encoded email is not supported; export a decoded text copy');
    text = content.slice(boundary).trim(); sender = header('from'); subject = header('subject');
  }
  if (!text.trim()) throw Error('Notice body is empty');
  return { text, source: { filename, sha256: digest(content), sender, subject, trust: 'User-selected file. Sender/header claims are unverified; content is untrusted.' } };
}
export function makeNoticeProposal(baseVersion: string, source: NoticeProposal['source'], rawTerms: string, before: Terms, plan: PlanResult, decision: CadenceDecision | undefined, at: Date): NoticeProposal {
  const missingPreviouslyKnown = plan.proposal && (Object.keys(before) as (keyof Terms)[]).some(k => before[k] != null && plan.proposal!.extracted_terms[k] == null);
  const usable = !missingPreviouslyKnown && plan.ok && plan.gate?.accepted && plan.gate.finalCadence !== 'ESCALATE' && plan.proposal;
  const terms = usable ? plan.proposal!.extracted_terms : undefined;
  const changes = terms ? (Object.keys(before) as (keyof Terms)[]).filter(k => before[k] !== terms[k]).map(k => ({ field: k, before: before[k], after: terms[k] })) : [];
  return { id: randomUUID(), baseVersion, source, rawTerms, at: at.toISOString(), expiresAt: new Date(at.getTime()+15*60_000).toISOString(),
    status: terms ? changes.length ? 'review' : 'no-change' : 'blocked', terms, changes, decision,
    missingFields: plan.clarification?.missing_fields,
    rationale: plan.clarification?.reason ?? (missingPreviouslyKnown ? 'Notice omits previously known fields. Missing text is not evidence that an option or condition was removed. Review the complete terms.' : terms ? plan.proposal!.rationale : plan.error ?? plan.gate?.reasons.join('; ') ?? 'Insufficient supported terms; no change may be applied'),
    citations: plan.clarification?.cited_facts ?? plan.proposal?.cited_facts ?? [] };
}
