import { spawn } from 'child_process';
import { killProcessTree } from './killTree.js';

/**
 * A project's git origin URL, for hub events (#208 review).
 *
 * Bounded at 1.5 s: it runs on the request path and per project in the flow
 * sync poller, and a git that hangs (network mount, credential prompt) must not
 * hold either. A lookup that timed out is answered as "no remote" but marked
 * not cacheable - cached, one slow first lookup on a loaded box shipped every
 * later event of the project without its remoteUrl. The timeout ends the whole
 * tree: on Windows git.exe is a wrapper, and a plain kill left the real git
 * running in the project's root, holding it open.
 */
export interface RemoteLookupDeps {
  run: (root: string, timeoutMs: number) => Promise<{ out: string; timedOut: boolean }>;
}

const TIMEOUT_MS = 1500;

const defaults: RemoteLookupDeps = {
  run: (root, timeoutMs) => new Promise(resolve => {
    let out = '';
    let timedOut = false;
    let done = false;
    const finish = (text: string) => { if (done) return; done = true; clearTimeout(timer); resolve({ out: text, timedOut }); };
    const child = spawn('git', ['remote', 'get-url', 'origin'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => { timedOut = true; killProcessTree(child); finish(''); }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', () => finish(''));
    child.on('close', code => finish(code === 0 ? out : ''));
  }),
};

/**
 * How long to remember an answer: a real one (a URL, or git saying there is
 * none) for good - undefined; a timed-out one for a minute. Forgotten at once,
 * every event of a slow project waited the full timeout again.
 */
export function remoteCacheLifetimeMs(answer: { cacheable: boolean }): number | undefined {
  return answer.cacheable ? undefined : 60_000;
}

export async function readRemoteUrl(root: string, deps: RemoteLookupDeps = defaults): Promise<{ url: string; cacheable: boolean }> {
  const { out, timedOut } = await deps.run(root, TIMEOUT_MS);
  return { url: out.trim(), cacheable: !timedOut };
}
