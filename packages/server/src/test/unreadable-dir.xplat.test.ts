/**
 * @file GitHub #208 phase 3 — a directory the specs can make unreadable, on every OS.
 *
 * sync-install-dir's prune must fail closed over a source subtree it cannot
 * list and stay lenient over a destination one. The specs made the directory
 * unreadable with `chmod 000`, which on Windows sets a read-only attribute that
 * directory listing ignores: the "unreadable" directory was read, and the
 * prune deleted what the spec exists to keep. An explicit deny ACE on listing
 * (icacls /deny ...:(RD)) is the Windows equivalent: readdir fails with EPERM
 * as it fails with EACCES under chmod 000. Either way it must always be undone,
 * or the spec's temp dir can never be removed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeUnreadable } from './helpers/unreadableDir';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let work = '';
afterEach(() => { if (work) fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); work = ''; });

describe('makeUnreadable()', () => {
  // root reads through chmod 000; the specs that use this skip as root too.
  it.skipIf(isRoot)('makes listing the directory fail, and the returned restore undoes it', () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-unreadable-'));
    const dir = path.join(work, 'locked');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x.md'), 'x');

    const restore = makeUnreadable(dir);
    let code = '';
    try {
      fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code ?? 'unknown';
    } finally {
      restore();
    }

    expect(['EACCES', 'EPERM']).toContain(code);
    expect(fs.readdirSync(dir)).toEqual(['x.md']);
  });

  it.skipIf(isRoot)('leaves a directory that can be removed once restored', () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-unreadable-'));
    const dir = path.join(work, 'locked');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x.md'), 'x');

    makeUnreadable(dir)();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    expect(fs.existsSync(work)).toBe(false);
    work = '';
  });
});
