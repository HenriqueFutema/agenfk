/**
 * The machine-only half of a project's files (CGLAB-625).
 *
 * `.agenfk/project.json` is the repository's shared settings, committed.
 * `.agenfk/local.json` is `{ projectId }` - a row id in this machine's
 * database - and must never be committed: in a teammate's clone it names a
 * project their database does not have, and two clones on one machine become
 * one project with one root.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { LOCAL_PROJECT_FILE } from '@agenfk/core';

export const LOCAL_FILE_REL = `.agenfk/${LOCAL_PROJECT_FILE}`;

/** Write `{ projectId }` to `<dir>/.agenfk/local.json`. */
export function writeLocalProjectId(dir: string, projectId: string): string {
  const file = path.join(dir, '.agenfk', LOCAL_PROJECT_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ projectId }, null, 2) + '\n', 'utf8');
  return file;
}

/**
 * Make git ignore `<dir>/.agenfk/local.json`.
 *
 * Asks git first (`check-ignore --no-index`), so a rule already covering it -
 * `.agenfk/`, a global excludes file - is left alone. Otherwise the entry goes
 * in `<dir>/.gitignore`, which is committed: every clone then ignores its own
 * local.json, which `.git/info/exclude` would do for this clone only.
 */
export function ensureLocalIgnored(dir: string): 'already' | 'added' | 'not-git' {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', LOCAL_FILE_REL], { cwd: dir, stdio: 'ignore', windowsHide: true });
    return 'already';
  } catch (e: any) {
    // 1 = not ignored. Anything else (128: not a repository; ENOENT: no git) means nothing to ignore it from.
    if (e?.status !== 1) return 'not-git';
  }
  const file = path.join(dir, '.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const sep = current && !current.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, `${current}${sep}${LOCAL_FILE_REL}\n`, 'utf8');
  return 'added';
}

/**
 * Remove a projectId from `<dir>/.agenfk/project.json`, keeping every other
 * key. A file left with nothing in it is deleted. Returns the id it removed,
 * or null when there was none (or the file could not be read as an object).
 */
export function stripLegacyProjectId(dir: string): string | null {
  const file = path.join(dir, '.agenfk', 'project.json');
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('projectId' in parsed)) return null;
  const { projectId, ...rest } = parsed as Record<string, unknown>;
  if (Object.keys(rest).length) fs.writeFileSync(file, JSON.stringify(rest, null, 2) + '\n', 'utf8');
  else fs.rmSync(file);
  return typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null;
}
