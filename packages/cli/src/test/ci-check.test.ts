/**
 * `agenfk ci check` and its GitHub Action (RFC-002, task bf07b5ef).
 *
 * CI asks one question per expensive step: may this step be skipped because a
 * receipt already certifies what it would do? The answer is an exit code —
 * 0 reuse, 10 run the step, 1 the policy requires a receipt and none qualifies
 * — and the promises pinned here are the ones that keep a skip honest:
 *
 *  - **CI recomputes the content itself**: the tree of its own checkout (the
 *    PR's merge result), never one a producer reports. Repository and PR come
 *    from the GitHub environment, or flags elsewhere.
 *  - **Only Enforce skips.** Off and Shadow always run the step; Shadow still
 *    says whether it would have reused, which is what Shadow measures.
 *  - **A candidate qualifies only on every count**: same tree, current command
 *    revision (verification) or the lens the call names (review), reusable by
 *    the hub, producer still on the allowlist, fresh where --max-age asks, and
 *    its report or findings actually downloaded.
 *  - **Never a silent pass**: a hub error or timeout runs the step, or blocks
 *    under --policy require. It is never 0.
 *  - **The call is the mapping**: --kind and --lens name the receipt the step
 *    stands for; a review call without a lens is refused.
 *
 * The hub here is a local HTTP stand-in (the real hub API is pinned by the
 * hub's own hub-ci-receipts-read spec), and the checkout is a real git repo.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { execFileSync, spawnSync } from 'child_process';
import * as yaml from 'js-yaml';
import { resolveCiContext, runCiCheck, runCiCheckCommand, CiCheckUsageError } from '../commands/ci';

const REPO = 'git@github.com:acme/app.git';
const TOKEN = 'ci_' + '1'.repeat(64);
const LOG = 'PASS everything\n';
const REPO_ROOT = path.resolve(__dirname, '../../../..');

let tmp: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();

/** A real checkout with one commit; its HEAD tree is what CI compares. */
function makeCheckout(): { dir: string; tree: string; commit: string } {
  const dir = fs.mkdtempSync(path.join(tmp, 'co-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ci@acme.test');
  git(dir, 'config', 'user.name', 'CI');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'one');
  return { dir, tree: git(dir, 'rev-parse', 'HEAD^{tree}'), commit: git(dir, 'rev-parse', 'HEAD') };
}

// ── the hub stand-in ─────────────────────────────────────────────────────────

interface FakeHub {
  url: string;
  requests: Array<{ method: string; url: string; auth: string | undefined }>;
  close: () => Promise<void>;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function fakeHub(handler: Handler): Promise<FakeHub> {
  const requests: FakeHub['requests'] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
    handler(req, res);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** A candidate as GET /v1/ci/receipts summarises it. */
const candidate = (tree: string, over: Record<string, any> = {}) => ({
  id: over.id ?? 'rcpt-1',
  kind: 'verification',
  cardId: 'card-root',
  contentTree: tree,
  commit: 'b'.repeat(40),
  commandRevision: 1,
  reusable: true,
  notReusableReason: null,
  installationId: 'inst-alice',
  producerAllowed: true,
  receivedAt: new Date().toISOString(),
  evidenceAt: new Date().toISOString(),
  report: { available: true, bytes: LOG.length },
  ...over,
});

const lookupBody = (mode: string, receipts: any[], over: Record<string, any> = {}) => ({
  repo: REPO,
  settings: { verifyCommand: 'npm test', revision: 1, receiptsMode: mode },
  lookup: { by: receipts.length ? 'pr' : null, pr: 42, cardId: 'card-root', tree: null },
  receipts,
  ...over,
});

/** The full receipt for GET /v1/ci/receipts/:id. */
const fullReceipt = (c: any) => ({
  ...c,
  receipt: c.kind === 'review'
    ? {
        id: c.id, kind: 'review', card: { id: 'card-root', title: 'Root story' },
        review: { recordId: 'rec-9', reviewer: { client: 'codex', sessionId: 'sess-9' }, lenses: c.lenses, findings: [{ title: 'Off by one', state: 'fixed', reason: 'fixed in abc' }] },
      }
    : {
        id: c.id, kind: 'verification', card: { id: 'card-root', title: c.cardTitle ?? 'Root story', closedBy: { name: 'Dev', email: 'dev@acme.test' } },
        execution: { id: 'exec-7', command: 'npm test', commandRevision: c.commandRevision },
      },
});

/** A hub that answers the lookup with `body`, and the receipt + report routes from it. */
function hubAnswering(body: any, opts: { reportStatus?: number } = {}): Handler {
  return (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/v1/ci/receipts') return json(res, 200, body);
    const m = u.pathname.match(/^\/v1\/ci\/receipts\/([^/]+)(\/report)?$/);
    const c = m && body.receipts.find((r: any) => r.id === decodeURIComponent(m[1]));
    if (!c) return json(res, 404, { code: 'receipt_not_found' });
    if (m![2]) {
      if (opts.reportStatus && opts.reportStatus !== 200) return json(res, opts.reportStatus, { code: 'report_unavailable' });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(LOG);
    }
    return json(res, 200, fullReceipt(c));
  };
}

describe('agenfk ci check', () => {
  let hub: FakeHub | null = null;
  let co: { dir: string; tree: string; commit: string };
  let outputFile: string;
  let summaryFile: string;
  let reportDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-ci-check-'));
    co = makeCheckout();
    outputFile = path.join(tmp, 'github_output');
    summaryFile = path.join(tmp, 'step_summary.md');
    reportDir = path.join(tmp, 'reports');
    fs.writeFileSync(outputFile, '');
    fs.writeFileSync(summaryFile, '');
  });

  afterEach(async () => {
    if (hub) await hub.close();
    hub = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const outputs = () => Object.fromEntries(
    fs.readFileSync(outputFile, 'utf8').split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

  const check = (over: Record<string, any> = {}) => runCiCheck({
    kind: 'verification',
    policy: 'run',
    hubUrl: hub!.url,
    token: TOKEN,
    repo: REPO,
    pr: 42,
    tree: co.tree,
    reportDir,
    timeoutMs: 2000,
    githubOutput: outputFile,
    stepSummary: summaryFile,
    ...over,
  });

  // ── context ────────────────────────────────────────────────────────────────
  describe('resolveCiContext', () => {
    it('takes the tree of the checkout, the repository and PR from the GitHub environment', () => {
      const event = path.join(tmp, 'event.json');
      fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 42 } }));
      const ctx = resolveCiContext({
        cwd: co.dir,
        env: { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'acme/app', GITHUB_EVENT_PATH: event },
      });
      expect(ctx).toEqual({ repo: 'https://github.com/acme/app.git', pr: 42, tree: co.tree });
    });

    it('reads the PR number from a pull request ref when there is no event file', () => {
      const ctx = resolveCiContext({ cwd: co.dir, env: { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'acme/app', GITHUB_REF: 'refs/pull/17/merge' } });
      expect(ctx.pr).toBe(17);
    });

    it('falls back to the origin remote and to no PR outside GitHub', () => {
      git(co.dir, 'remote', 'add', 'origin', 'git@gitlab.example:acme/app.git');
      const ctx = resolveCiContext({ cwd: co.dir, env: {} });
      expect(ctx).toEqual({ repo: 'git@gitlab.example:acme/app.git', pr: null, tree: co.tree });
    });

    it('lets flags override what the environment says', () => {
      const ctx = resolveCiContext({
        cwd: co.dir, env: { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'acme/app', GITHUB_REF: 'refs/pull/17/merge' },
        repo: 'git@github.com:acme/other.git', pr: '5',
      });
      expect(ctx).toMatchObject({ repo: 'git@github.com:acme/other.git', pr: 5, tree: co.tree });
    });

    it('refuses a directory that is not a git checkout', () => {
      const bare = fs.mkdtempSync(path.join(tmp, 'nogit-'));
      expect(() => resolveCiContext({ cwd: bare, env: { GITHUB_REPOSITORY: 'acme/app', GITHUB_SERVER_URL: 'https://github.com' } }))
        .toThrow(CiCheckUsageError);
    });

    it('refuses a PR that is not a positive whole number', () => {
      expect(() => resolveCiContext({ cwd: co.dir, env: { GITHUB_REPOSITORY: 'acme/app', GITHUB_SERVER_URL: 'https://github.com' }, pr: 'abc' }))
        .toThrow(CiCheckUsageError);
    });
  });

  // ── reuse ────────────────────────────────────────────────────────────────
  describe('in Enforce', () => {
    // CodeQL 169: escaping the pipe but not the backslash let `\|` in a card
    // title end the summary's table cell.
    it('keeps a card title with a backslash-pipe inside its summary table cell', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [{ ...candidate(co.tree), cardTitle: 'a \\| b' }])));
      expect((await check()).exitCode).toBe(0);
      const row = fs.readFileSync(summaryFile, 'utf8').split('\n').find(l => l.includes('a \\'))!;
      expect(row).toContain('a \\\\\\| b');
    });

    it('reuses a matching verification receipt: exit 0, report downloaded, outputs and summary written', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [candidate(co.tree)])));
      const r = await check();
      expect(r.exitCode).toBe(0);
      expect(r.result).toMatchObject({ outcome: 'reuse', reason: 'matched', mode: 'enforce', wouldReuse: true, receiptId: 'rcpt-1' });
      // The lookup carried the token and everything CI computed itself.
      const lookup = hub.requests.find(q => q.url.startsWith('/v1/ci/receipts?'))!;
      expect(lookup.auth).toBe(`Bearer ${TOKEN}`);
      const qs = new URL(lookup.url, 'http://x').searchParams;
      expect(Object.fromEntries(qs)).toMatchObject({ repo: REPO, kind: 'verification', pr: '42', tree: co.tree });
      // The original log, downloaded where the job can publish it.
      expect(fs.readFileSync(path.join(reportDir, 'rcpt-1.log'), 'utf8')).toBe(LOG);
      expect(outputs()).toMatchObject({ run: 'false', decision: 'reuse', reason: 'matched', 'receipt-id': 'rcpt-1', 'would-reuse': 'true' });
      const summary = fs.readFileSync(summaryFile, 'utf8');
      expect(summary).toContain('Reused result');
      expect(summary).toContain('rcpt-1');
      expect(summary).toContain('exec-7');
      expect(summary).toContain('npm test');
      expect(summary).toContain('card-root');
    });

    it('takes an older candidate that qualifies when the newest does not', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [
        candidate('c'.repeat(40), { id: 'newest' }),
        candidate(co.tree, { id: 'older' }),
      ])));
      const r = await check();
      expect(r.exitCode).toBe(0);
      expect(r.result.receiptId).toBe('older');
    });

    const runsBecause = async (receipts: any[], reason: string, over: Record<string, any> = {}, body: Record<string, any> = {}) => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', receipts, body)));
      const r = await check(over);
      expect(r.exitCode, JSON.stringify(r.result)).toBe(10);
      expect(r.result).toMatchObject({ outcome: 'run', reason, wouldReuse: false });
      expect(outputs()).toMatchObject({ run: 'true', decision: 'run', reason });
      expect(fs.readFileSync(summaryFile, 'utf8')).not.toContain('Reused result');
      return r;
    };

    it('runs the step when there is no receipt', () => runsBecause([], 'no_receipt'));
    it('runs the step when no receipt has this checkout\'s tree', () => runsBecause([candidate('c'.repeat(40))], 'tree_mismatch'));
    it('runs the step when the command was revised since', () =>
      runsBecause([candidate('TREE', { commandRevision: 1 })].map(c => ({ ...c, contentTree: co.tree })), 'command_revision_changed', {},
        { settings: { verifyCommand: 'npm run verify', revision: 2, receiptsMode: 'enforce' } }));
    it('runs the step when the hub ruled the receipt not reusable', () =>
      runsBecause([candidate('x', { reusable: false, notReusableReason: 'report_over_cap' })].map(c => ({ ...c, contentTree: co.tree })), 'not_reusable'));
    it('runs the step when the producer is no longer on the allowlist', () =>
      runsBecause([candidate('x', { producerAllowed: false })].map(c => ({ ...c, contentTree: co.tree })), 'producer_not_allowed'));
    it('runs the step when the receipt is older than --max-age allows', () =>
      runsBecause([candidate('x', { evidenceAt: new Date(Date.now() - 30 * 864e5).toISOString() })].map(c => ({ ...c, contentTree: co.tree })), 'stale', { maxAgeDays: 7 }));
    // Codex review: a receipt that waited offline arrives "fresh"; its evidence is not.
    it('measures --max-age from when the evidence was made, not when the hub received it', () =>
      runsBecause([candidate('x', { receivedAt: new Date().toISOString(), evidenceAt: new Date(Date.now() - 30 * 864e5).toISOString() })].map(c => ({ ...c, contentTree: co.tree })), 'stale', { maxAgeDays: 7 }));
    it('counts a receipt that cannot say when its evidence was made as stale under --max-age', () =>
      runsBecause([candidate('x', { evidenceAt: null })].map(c => ({ ...c, contentTree: co.tree })), 'stale', { maxAgeDays: 7 }));
    it('never matches a command revision neither side states', () =>
      // Absent on both sides (JSON drops undefined): undefined === undefined must not be a match.
      runsBecause([candidate('x', { commandRevision: undefined })].map(c => ({ ...c, contentTree: co.tree })), 'command_revision_changed', {},
        { settings: { verifyCommand: 'npm test', receiptsMode: 'enforce' } }));
    it('runs the step when the receipt kept no report', () =>
      runsBecause([candidate('x', { report: { available: false, bytes: 99_000_000 } })].map(c => ({ ...c, contentTree: co.tree })), 'report_unavailable'));

    it('reuses an old receipt when no --max-age is asked for', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [candidate(co.tree, { receivedAt: '2020-01-01T00:00:00.000Z' })])));
      expect((await check()).exitCode).toBe(0);
    });

    it('runs the step when the report cannot be downloaded', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [candidate(co.tree)]), { reportStatus: 404 }));
      const r = await check();
      expect(r.exitCode).toBe(10);
      expect(r.result.reason).toBe('report_unavailable');
    });

    it('blocks under --policy require when nothing qualifies', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [candidate('c'.repeat(40))])));
      const r = await check({ policy: 'require' });
      expect(r.exitCode).toBe(1);
      expect(r.result).toMatchObject({ outcome: 'block', reason: 'tree_mismatch' });
      expect(outputs()).toMatchObject({ run: 'true', decision: 'block' });
    });
  });

  // ── Codex review: what comes back from the hub is checked, not trusted ────
  describe('evidence and outputs from a hub that misbehaves', () => {
    it('a receipt id cannot forge another GITHUB_OUTPUT line', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('shadow', [candidate(co.tree, { id: 'r\nrun=false' })])));
      const r = await check();
      expect(r.exitCode).toBe(10);
      const lines = fs.readFileSync(outputFile, 'utf8').split('\n').filter(Boolean);
      expect(lines.filter(l => l.startsWith('run=')), lines.join(' | ')).toEqual(['run=true']);
      expect(lines.every(l => /^[a-z-]+=/.test(l)), lines.join(' | ')).toBe(true);
    });

    it('a review whose findings did not come back is not reused', async () => {
      const c = candidate(co.tree, { id: 'rv-1', kind: 'review', commandRevision: null, lenses: ['general'], report: { available: false, bytes: null } });
      hub = await fakeHub((req, res) => {
        if ((req.url ?? '').startsWith('/v1/ci/receipts?')) return json(res, 200, lookupBody('enforce', [c]));
        return json(res, 200, {}); // the detail: 200, but no receipt in it
      });
      const r = await check({ kind: 'review', lens: 'general' });
      expect(r.exitCode, JSON.stringify(r.result)).toBe(10);
      expect(r.result.reason).toBe('report_unavailable');
    });

    it('a review detail that is the right receipt but carries no findings list is not reused', async () => {
      const c = candidate(co.tree, { id: 'rv-1', kind: 'review', commandRevision: null, lenses: ['general'], report: { available: false, bytes: null } });
      hub = await fakeHub((req, res) => {
        if ((req.url ?? '').startsWith('/v1/ci/receipts?')) return json(res, 200, lookupBody('enforce', [c]));
        const full = fullReceipt(c);
        return json(res, 200, { ...full, receipt: { ...full.receipt, review: { ...full.receipt.review, findings: 'none' } } });
      });
      const r = await check({ kind: 'review', lens: 'general' });
      expect(r.exitCode, JSON.stringify(r.result)).toBe(10);
      expect(r.result.reason).toBe('report_unavailable');
    });

    it('a detail naming another receipt is not this receipt\'s evidence', async () => {
      const c = candidate(co.tree);
      hub = await fakeHub((req, res) => {
        const u = req.url ?? '';
        if (u.startsWith('/v1/ci/receipts?')) return json(res, 200, lookupBody('enforce', [c]));
        if (u.endsWith('/report')) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(LOG); }
        return json(res, 200, fullReceipt({ ...c, id: 'someone-else' }));
      });
      const r = await check();
      expect(r.exitCode).toBe(10);
      expect(r.result.reason).toBe('report_unavailable');
    });

    it('the timeout covers the body too: a hub that sends headers and stalls is not waited on', async () => {
      hub = await fakeHub((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"repo":'); });
      const started = Date.now();
      const r = await check({ timeoutMs: 200 });
      expect(r.exitCode).toBe(10);
      expect(r.result.reason).toBe('hub_unavailable');
      expect(Date.now() - started).toBeLessThan(5000);
    });
  });

  // ── reviews ──────────────────────────────────────────────────────────────
  describe('a review step', () => {
    const reviewCandidate = (lenses: string[], over: Record<string, any> = {}) =>
      candidate(co.tree, { id: 'rv-1', kind: 'review', commandRevision: null, lenses, report: { available: false, bytes: null }, ...over });

    it('reuses a review that covered the lens the call names, and downloads its findings', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [reviewCandidate(['general', 'security'])])));
      const r = await check({ kind: 'review', lens: 'security' });
      expect(r.exitCode, JSON.stringify(r.result)).toBe(0);
      const lookup = hub.requests.find(q => q.url.startsWith('/v1/ci/receipts?'))!;
      expect(new URL(lookup.url, 'http://x').searchParams.get('lens')).toBe('security');
      const findings = JSON.parse(fs.readFileSync(path.join(reportDir, 'rv-1.findings.json'), 'utf8'));
      expect(findings).toEqual([{ title: 'Off by one', state: 'fixed', reason: 'fixed in abc' }]);
      const summary = fs.readFileSync(summaryFile, 'utf8');
      expect(summary).toContain('Reused result');
      expect(summary).toContain('rec-9');
      expect(summary).toContain('security');
    });

    it('does not let a review stand in for a lens it did not perform', async () => {
      // A hub that ignored the lens filter must still not produce a skip.
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [reviewCandidate(['general'])])));
      const r = await check({ kind: 'review', lens: 'security' });
      expect(r.exitCode).toBe(10);
      expect(r.result.reason).toBe('lens_not_covered');
    });

    it('needs no command revision to match', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [reviewCandidate(['general'])]), {}));
      const r = await check({ kind: 'review', lens: 'general' });
      expect(r.exitCode).toBe(0);
    });

    it('refuses a review call that names no lens', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [reviewCandidate(['general'])])));
      await expect(check({ kind: 'review' })).rejects.toThrow(CiCheckUsageError);
      expect(hub.requests).toHaveLength(0);
    });
  });

  // ── modes ────────────────────────────────────────────────────────────────
  describe('Off and Shadow', () => {
    it('Shadow always runs the step but says it would have reused', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('shadow', [candidate(co.tree)])));
      const r = await check({ policy: 'require' });
      expect(r.exitCode).toBe(10);
      expect(r.result).toMatchObject({ outcome: 'run', mode: 'shadow', wouldReuse: true, reason: 'shadow_mode', receiptId: 'rcpt-1' });
      expect(outputs()).toMatchObject({ run: 'true', 'would-reuse': 'true' });
      expect(fs.readFileSync(summaryFile, 'utf8')).toMatch(/shadow/i);
    });

    it('Shadow says when it would not have reused, and why', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('shadow', [candidate('c'.repeat(40))])));
      const r = await check({ policy: 'require' });
      expect(r.exitCode).toBe(10);
      expect(r.result).toMatchObject({ wouldReuse: false, reason: 'tree_mismatch' });
    });

    it('Off runs the step, even under --policy require', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('off', [candidate(co.tree)])));
      const r = await check({ policy: 'require' });
      expect(r.exitCode).toBe(10);
      expect(r.result).toMatchObject({ outcome: 'run', reason: 'receipts_off', wouldReuse: false });
    });
  });

  // ── the hub failing ──────────────────────────────────────────────────────
  describe('never a silent pass', () => {
    it('runs the step when the hub answers with an error', async () => {
      hub = await fakeHub((_req, res) => json(res, 500, { error: 'boom' }));
      const r = await check();
      expect(r.exitCode).toBe(10);
      expect(r.result).toMatchObject({ outcome: 'run', reason: 'hub_unavailable' });
      expect(outputs()).toMatchObject({ run: 'true', decision: 'run' });
    });

    it('blocks on a hub error under --policy require', async () => {
      hub = await fakeHub((_req, res) => json(res, 401, { error: 'Invalid or revoked token' }));
      const r = await check({ policy: 'require' });
      expect(r.exitCode).toBe(1);
      expect(r.result).toMatchObject({ outcome: 'block', reason: 'hub_unavailable' });
    });

    it('runs the step when the hub does not answer in time', async () => {
      hub = await fakeHub(() => { /* never answers */ });
      const started = Date.now();
      const r = await check({ timeoutMs: 200 });
      expect(r.exitCode).toBe(10);
      expect(r.result.reason).toBe('hub_unavailable');
      expect(Date.now() - started).toBeLessThan(5000);
    });

    it('runs the step when the hub answers something that is not a lookup', async () => {
      hub = await fakeHub((_req, res) => json(res, 200, { hello: 'world' }));
      const r = await check();
      expect(r.exitCode).toBe(10);
      expect(r.result.reason).toBe('hub_unavailable');
    });
  });

  // ── the command around it ────────────────────────────────────────────────
  describe('runCiCheckCommand', () => {
    it('reads the hub and token from the environment and the context from the checkout', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [candidate(co.tree)])));
      const code = await runCiCheckCommand(
        { kind: 'verification', reportDir, pr: '42', repo: REPO },
        { cwd: co.dir, env: { AGENFK_HUB_URL: hub.url, AGENFK_CI_TOKEN: TOKEN, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile } },
      );
      expect(code).toBe(0);
      expect(outputs().decision).toBe('reuse');
    });

    it('fails loudly without a token or a hub URL', async () => {
      const lines: string[] = [];
      const code = await runCiCheckCommand(
        { kind: 'verification', reportDir },
        { cwd: co.dir, env: { GITHUB_REPOSITORY: 'acme/app', GITHUB_SERVER_URL: 'https://github.com', GITHUB_OUTPUT: outputFile }, log: (l: string) => lines.push(l) },
      );
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/AGENFK_CI_TOKEN|AGENFK_HUB_URL/);
    });

    it('refuses an unknown kind or policy', async () => {
      const env = { AGENFK_HUB_URL: 'http://127.0.0.1:9', AGENFK_CI_TOKEN: TOKEN };
      expect(await runCiCheckCommand({ kind: 'build', reportDir }, { cwd: co.dir, env, log: () => undefined })).toBe(1);
      expect(await runCiCheckCommand({ kind: 'verification', policy: 'maybe', reportDir }, { cwd: co.dir, env, log: () => undefined })).toBe(1);
    });
  });
});

// ── the GitHub Action ──────────────────────────────────────────────────────
describe.skipIf(process.platform === 'win32')('the ci-check GitHub Action', () => {
  const actionPath = path.join(REPO_ROOT, 'actions', 'ci-check', 'action.yml');

  /** Run the action's check step with a stub npx that exits `code`, as the CLI would. */
  function runStep(code: number, env: Record<string, string>) {
    const action: any = yaml.load(fs.readFileSync(actionPath, 'utf8'));
    expect(action.runs.using).toBe('composite');
    const step = action.runs.steps.find((s: any) => s.id === 'check');
    expect(step, 'a step with id "check"').toBeTruthy();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-action-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const argvFile = path.join(dir, 'argv');
    fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\nexit ${code}\n`, { mode: 0o755 });
    const out = path.join(dir, 'out');
    fs.writeFileSync(out, '');
    // The step's own env block, with the inputs this test plays.
    const stepEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(step.env ?? {})) {
      const m = String(v).match(/^\$\{\{\s*inputs\.([\w-]+)\s*\}\}$/);
      stepEnv[k] = m ? (env[m[1]] ?? '') : String(v);
    }
    const r = spawnSync('bash', ['-e', '-c', step.run], {
      env: { PATH: `${bin}:/usr/bin:/bin`, GITHUB_OUTPUT: out, ...stepEnv },
      encoding: 'utf8',
    });
    const argv = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, 'utf8').split('\n').filter(Boolean) : [];
    fs.rmSync(dir, { recursive: true, force: true });
    return { status: r.status, argv, stderr: r.stderr };
  }

  it('passes on exit 0 and exit 10, so only the steps it gates are skipped', () => {
    expect(runStep(0, { kind: 'verification' }).status).toBe(0);
    expect(runStep(10, { kind: 'verification' }).status).toBe(0);
  });

  it('fails the job on exit 1, when the policy requires a receipt', () => {
    expect(runStep(1, { kind: 'verification', policy: 'require' }).status).toBe(1);
  });

  it('runs agenfk ci check with the kind, lens and policy it was given', () => {
    const { argv } = runStep(0, { kind: 'review', lens: 'security', policy: 'require', 'agenfk-version': '2.1.0' });
    expect(argv[0]).toMatch(/^(-y|--yes)$/);
    expect(argv).toContain('agenfk@2.1.0');
    const at = argv.indexOf('ci');
    expect(argv.slice(at, at + 2)).toEqual(['ci', 'check']);
    expect(argv[argv.indexOf('--kind') + 1]).toBe('review');
    expect(argv[argv.indexOf('--lens') + 1]).toBe('security');
    expect(argv[argv.indexOf('--policy') + 1]).toBe('require');
  });

  it('passes no --lens when none was given', () => {
    const { argv } = runStep(0, { kind: 'verification' });
    expect(argv).not.toContain('--lens');
  });

  it('never splices an input into the script, so an input cannot run code', () => {
    const { argv, status } = runStep(0, { kind: 'verification', lens: '$(touch /tmp/agenfk-pwned)"; exit 3; "' });
    expect(status).toBe(0);
    expect(argv[argv.indexOf('--lens') + 1]).toBe('$(touch /tmp/agenfk-pwned)"; exit 3; "');
  });

  it('exposes the step\'s run and decision outputs as the action\'s', () => {
    const action: any = yaml.load(fs.readFileSync(actionPath, 'utf8'));
    expect(action.outputs.run.value).toMatch(/steps\.check\.outputs\.run/);
    expect(action.outputs.decision.value).toMatch(/steps\.check\.outputs\.decision/);
    expect(action.outputs['receipt-id'].value).toMatch(/steps\.check\.outputs\.receipt-id/);
  });
});
