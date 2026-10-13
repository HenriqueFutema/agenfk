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
import { readRemoteUrl } from '../projectRemote';
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
