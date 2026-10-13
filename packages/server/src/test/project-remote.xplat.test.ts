/**
 * @file #208 review — a project's git remote, read for hub events.
 *
 * A lookup that timed out used to be cached as "no remote" for the life of the
 * server, so one slow first `git remote get-url` (a loaded Windows box) shipped
 * every later event of that project without its remoteUrl. And on Windows the
 * timeout's plain kill ended git.exe - a wrapper - while the real git ran on in
 * the project's root, holding it open.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { oneInFlight, readRemoteUrl, remoteCacheLifetimeMs } from '../projectRemote';
import { removeTempDir } from './helpers/tempDir';

describe('readRemoteUrl()', () => {
  it('answers the origin URL, to be remembered', async () => {
    const r = await readRemoteUrl('/repo', { run: async () => ({ out: 'git@github.com:o/r.git\n', timedOut: false }) });
    expect(r).toEqual({ url: 'git@github.com:o/r.git', cacheable: true });
  });

  it('answers no remote, to be remembered, when git says there is none', async () => {
    expect(await readRemoteUrl('/repo', { run: async () => ({ out: '', timedOut: false }) })).toEqual({ url: '', cacheable: true });
  });

  it('answers no remote but NOT to be remembered when the lookup timed out: the next event asks again', async () => {
    expect(await readRemoteUrl('/repo', { run: async () => ({ out: '', timedOut: true }) })).toEqual({ url: '', cacheable: false });
  });

  // Remembered forever, one slow lookup lost the remote for the server's life; asked again
  // on every event, each event of a slow project waited the full 1.5 s (a test under load
  // missed its hub event). A timeout is remembered briefly, then asked again.
  it('keeps a real answer for good, and a timed-out one for a minute', () => {
    expect(remoteCacheLifetimeMs({ url: 'x', cacheable: true })).toBeUndefined();
    expect(remoteCacheLifetimeMs({ url: '', cacheable: true })).toBeUndefined();
    expect(remoteCacheLifetimeMs({ url: '', cacheable: false })).toBe(60_000);
  });

  // A verify that closes a card emits two events back to back: each started its own lookup,
  // and a late timeout overwrote the good URL the other had just cached (review of f94e1694).
  it('runs one lookup per project at a time: concurrent callers share it, and a later one starts afresh', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const warm = oneInFlight(async (id: string) => { started.push(id); await gate; });
    const a = warm('p1'); const b = warm('p1'); const c = warm('p2');
    expect(started).toEqual(['p1', 'p2']);
    release();
    await Promise.all([a, b, c]);
    await warm('p1');
    expect(started).toEqual(['p1', 'p2', 'p1']);
  });

  it('a failed lookup does not stick: the next caller starts afresh', async () => {
    let calls = 0;
    const warm = oneInFlight(async () => { calls++; throw new Error('boom'); });
    await expect(warm('p')).rejects.toThrow('boom');
    await expect(warm('p')).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });

  it('reads a real repository with its own git', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-remote-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
      execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/o/r.git'], { cwd: dir, windowsHide: true });
      expect(await readRemoteUrl(dir)).toEqual({ url: 'https://example.com/o/r.git', cacheable: true });
    } finally {
      removeTempDir(dir);
    }
  });
});
