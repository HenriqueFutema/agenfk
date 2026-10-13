/**
 * @file GitHub #208 phase 5 — telling "could not be run" from "ran and failed" on Windows.
 *
 * sh answers a missing command with exit 127. cmd.exe answers it with exit 1 -
 * the same code a red suite gives - and a localised message on stderr. So on
 * Windows a broken PATH or a misspelt runner read as a failing suite. The
 * command still runs as written; only when it FAILS is its first word looked
 * up the way cmd.exe would, and the report says when it resolves to nothing.
 */
import { describe, it, expect } from 'vitest';
import { missingCommandOnWindows } from '../commandNotFound';

const deps = (found: string[]) => ({
  pathEnv: 'C:\\tools;C:\\Windows\\System32',
  pathExt: '.COM;.EXE;.BAT;.CMD',
  cwd: 'C:\\repo',
  exists: (p: string) => found.includes(p.toLowerCase()),
});

describe('missingCommandOnWindows()', () => {
  it('names a first word found nowhere: not a builtin, not a file, not on PATH', () => {
    expect(missingCommandOnWindows('this-binary-does-not-exist-agenfk --run', deps([]))).toBe('this-binary-does-not-exist-agenfk');
  });

  it('finds a command on PATH under any PATHEXT extension', () => {
    expect(missingCommandOnWindows('npm test', deps(['c:\\tools\\npm.cmd']))).toBeNull();
    expect(missingCommandOnWindows('node -e 1', deps(['c:\\tools\\node.exe']))).toBeNull();
  });

  it("knows cmd.exe's own commands, which are on no PATH", () => {
    for (const c of ['exit 1', 'echo hi', 'cd sub && npm test', 'IF EXIST x echo y', 'set A=1']) {
      expect(missingCommandOnWindows(c, deps([])), c).toBeNull();
    }
  });

  it('takes a quoted path, a relative path and a path with its extension as they are', () => {
    expect(missingCommandOnWindows('"C:\\Program Files\\nodejs\\node.exe" -v', deps(['c:\\program files\\nodejs\\node.exe']))).toBeNull();
    expect(missingCommandOnWindows('.\\run.cmd', deps(['c:\\repo\\run.cmd']))).toBeNull();
    expect(missingCommandOnWindows('C:\\gone\\tool.exe', deps([]))).toBe('C:\\gone\\tool.exe');
  });

  it('says nothing for a command it cannot read a first word from', () => {
    expect(missingCommandOnWindows('', deps([]))).toBeNull();
    expect(missingCommandOnWindows('"unterminated', deps([]))).toBeNull();
  });
});
