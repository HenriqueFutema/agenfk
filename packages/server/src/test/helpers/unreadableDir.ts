import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * Make `dir` unlistable; returns the function that undoes it (GitHub #208 phase 3).
 *
 * Off Windows that is `chmod 000`, as the specs always did. On Windows chmod
 * only sets a read-only attribute, which listing a directory ignores, so the
 * equivalent is an explicit deny ACE for listing (RD) granted to Everyone:
 * readdir then fails with EPERM, the way it fails with EACCES under chmod 000.
 * The owner keeps the right to change the ACL, so the deny can always be
 * removed again - call the returned function in a `finally`, or the directory
 * cannot be listed (or deleted) afterwards.
 */
export function makeUnreadable(dir: string): () => void {
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, 0o000);
    return () => fs.chmodSync(dir, 0o755);
  }
  const icacls = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  const EVERYONE = '*S-1-1-0';
  execFileSync(icacls, [dir, '/deny', `${EVERYONE}:(RD)`], { stdio: 'pipe', windowsHide: true });
  return () => { execFileSync(icacls, [dir, '/remove:d', EVERYONE], { stdio: 'pipe', windowsHide: true }); };
}
