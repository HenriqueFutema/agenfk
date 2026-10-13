import path from 'path';
import { spawnSync } from 'child_process';

/**
 * Kill a command the server spawned, with everything it started (#208).
 *
 * Off Windows the server spawns a command in its own process group, and a
 * negative pid kills the group: a runner's workers die with the shell instead
 * of outliving it (a leftover one could write the NEXT capture's report). A
 * command that is not a group leader has no such group; the kill throws and
 * the child itself is killed, as before.
 *
 * On Windows there are no process groups - the negative pid always threw, and
 * only cmd.exe died while npm, vitest and their workers ran on. `taskkill /T`
 * ends the whole tree; when it cannot (the process is already gone, or
 * taskkill is missing) the child itself is killed.
 */
export interface KillTreeDeps {
  platform: NodeJS.Platform;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  /** End `pid` and its descendants; false when that did not happen. */
  taskkill: (pid: number) => boolean;
}

const defaults: KillTreeDeps = {
  platform: process.platform,
  killPid: (pid, signal) => { process.kill(pid, signal); },
  taskkill: (pid) => {
    const exe = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const r = spawnSync(exe, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
    return r.status === 0;
  },
};

export function killProcessTree(
  child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean },
  deps: KillTreeDeps = defaults,
): void {
  const killChild = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
  if (!child.pid) { killChild(); return; }
  if (deps.platform === 'win32') {
    if (!deps.taskkill(child.pid)) killChild();
    return;
  }
  try { deps.killPid(-child.pid, 'SIGKILL'); } catch { killChild(); }
}
