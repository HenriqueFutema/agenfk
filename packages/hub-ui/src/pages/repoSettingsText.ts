// Words for the Repositories page (RFC-002). Every state is said in words, not
// colour alone, and every time in UTC: a receipt is evidence an admin compares
// with CI logs, which are in UTC too.

export type ReceiptsMode = 'off' | 'shadow' | 'enforce';

export interface RepoView {
  remoteUrl: string;
  verifyCommand: string;
  revision: number;
  receiptsMode: ReceiptsMode;
  shadowThreshold: number | null;
  producers: string[];
  createdAt: string;
  updatedAt: string;
  lastReceiptAt?: string | null;
}

export interface RevisionView {
  revision: number;
  verifyCommand: string;
  source: 'init' | 'admin';
  actorEmail: string | null;
  installationId: string | null;
  createdAt: string;
}

export interface ReceiptView {
  id: string;
  kind: 'verification' | 'review';
  cardId: string | null;
  cardTitle: string | null;
  contentTree: string | null;
  commit: string | null;
  commandRevision: number | null;
  reusable: boolean;
  notReusableReason: string | null;
  installationId: string;
  receivedAt: string;
  lenses?: string[];
}

export const MODE_LABEL: Record<ReceiptsMode, string> = { off: 'Off', shadow: 'Shadow', enforce: 'Enforce' };

export const MODE_HELP: Record<ReceiptsMode, string> = {
  off: 'Nothing changes: cards close as today and CI runs every step.',
  shadow: 'Root cards publish receipts; CI checks them but still runs every step, and says whether it would have reused one.',
  enforce: 'CI skips the steps a matching receipt covers.',
};

const REASON_WORDS: Record<string, string> = {
  producer_not_allowed: 'the machine is not an allowed producer',
  report_over_cap: 'the report is bigger than the hub keeps',
  not_reusable_by_producer: 'the machine that sent it did not offer it for reuse',
};

/** Why a receipt cannot be reused, in words; an unknown code is shown as it is. */
export const notReusableWords = (reason: string | null): string =>
  reason ? (REASON_WORDS[reason] ?? reason.replace(/_/g, ' ')) : 'no reason recorded';

/** `2026-06-03 10:15 UTC`, or the input as given when it is not a time. */
export function utc(ts: string | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/** Who made a command revision, in words. */
export const revisionAuthor = (r: RevisionView): string =>
  r.source === 'init'
    ? `Initialized by installation ${r.installationId ?? 'unknown'}`
    : `Revised by ${r.actorEmail ?? 'an admin'}`;

export const repoQuery = (repo: string) => `repo=${encodeURIComponent(repo)}`;
