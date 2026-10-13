/**
 * @file #208 branch review — a timed-out command is killed with everything it started, on Windows too.
 *
 * Off Windows the server spawns a command in its own process group and kills
 * the group. On Windows a negative pid throws, and the fallback killed only
 * cmd.exe: npm, vitest and their workers ran on, and a leftover one could write
 * the NEXT capture's report. `taskkill /T` ends the whole tree there.
 */
import { describe, it, expect } from 'vitest';
import { killProcessTree, type KillTreeDeps } from '../killTree';

function fakes(platform: NodeJS.Platform, opts: { groupKillThrows?: boolean; taskkillOk?: boolean } = {}) {
  const calls: string[] = [];
  const deps: KillTreeDeps = {
    platform,
    killPid: (pid, sig) => {
      calls.push(`kill ${pid} ${sig}`);
      if (pid < 0 && opts.groupKillThrows) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    },
    taskkill: (pid) => { calls.push(`taskkill ${pid}`); return opts.taskkillOk ?? true; },
  };
  const child = { pid: 42, kill: (sig?: NodeJS.Signals) => { calls.push(`child.kill ${sig}`); return true; } };
  return { deps, child, calls };
}

describe('killProcessTree()', () => {
  it('off Windows, kills the process group', () => {
    const { deps, child, calls } = fakes('linux');
    killProcessTree(child, deps);
    expect(calls).toEqual(['kill -42 SIGKILL']);
  });

  it('off Windows, falls back to the child when there is no group to kill', () => {
    const { deps, child, calls } = fakes('darwin', { groupKillThrows: true });
    killProcessTree(child, deps);
    expect(calls).toEqual(['kill -42 SIGKILL', 'child.kill SIGKILL']);
  });

  it('on Windows, ends the whole tree with taskkill, not just cmd.exe', () => {
    const { deps, child, calls } = fakes('win32');
    killProcessTree(child, deps);
    expect(calls).toEqual(['taskkill 42']);
  });

  it('on Windows, still kills the child itself when taskkill fails', () => {
    const { deps, child, calls } = fakes('win32', { taskkillOk: false });
    killProcessTree(child, deps);
    expect(calls).toEqual(['taskkill 42', 'child.kill SIGKILL']);
  });

  it('does nothing to a child that never got a pid (spawn failed)', () => {
    const { deps, calls } = fakes('win32');
    const child = { pid: undefined, kill: () => { calls.push('child.kill'); return true; } };
    killProcessTree(child, deps);
    expect(calls).toEqual(['child.kill']);
  });
});
