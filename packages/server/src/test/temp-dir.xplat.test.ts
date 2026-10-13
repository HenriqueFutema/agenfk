/**
 * @file #208 — a spec's teardown leaves a temp dir a background process holds open on Windows, and fails on anything else.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { removeTempDir, type TempDirDeps } from './helpers/tempDir';

function deps(platform: NodeJS.Platform, code: string): TempDirDeps & { warned: string[] } {
  const warned: string[] = [];
  return {
    platform,
    rm: () => { throw Object.assign(new Error(code), { code }); },
    warn: (m) => { warned.push(m); },
    warned,
  };
}

describe('removeTempDir()', () => {
  it('removes the directory and everything in it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-tempdir-'));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'f'), 'x');
    removeTempDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('on Windows, warns and goes on when the directory is still in use (EBUSY, EPERM)', () => {
    for (const code of ['EBUSY', 'EPERM']) {
      const d = deps('win32', code);
      expect(() => removeTempDir('C:\\held', d)).not.toThrow();
      expect(d.warned).toEqual([`[test teardown] left C:\\held: a background process still has it open (${code})`]);
    }
  });

  it('on Windows, still throws any other error', () => {
    expect(() => removeTempDir('C:\\x', deps('win32', 'EINVAL'))).toThrow(/EINVAL/);
  });

  it('off Windows, a directory in use is still an error', () => {
    expect(() => removeTempDir('/x', deps('linux', 'EBUSY'))).toThrow(/EBUSY/);
  });
});
