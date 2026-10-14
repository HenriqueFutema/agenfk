/**
 * #208 phase 6: the whole suite runs on Windows in CI, not only the curated
 * subset in vitest.windows.config.ts (which stays as a quick local run, `npm
 * run test:windows`). A full local run on a managed Windows box takes over an
 * hour, so GitHub's runners are where it is checked, split into shards so it
 * costs minutes of wall-clock time.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const CI_YML = path.join(ROOT, '.github/workflows/ci.yml');

/** The text of one job: from its key to the next job's key, or the end of the file. */
function jobBlock(content: string, job: string): string {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex(l => l === `  ${job}:`);
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

describe('Windows full-suite CI job (#208)', () => {
  const content = fs.readFileSync(CI_YML, 'utf8');
  const job = jobBlock(content, 'windows-full');

  it('names its OS and what it runs, in the "OS · what" form the Linux job uses too', () => {
    expect(job).toMatch(/^\s+name:\s*Windows · full suite \(\$\{\{\s*matrix\.shard\s*\}\}\/8\)\s*$/m);
    expect(jobBlock(content, 'build-and-test')).toMatch(/^\s+name:\s*Linux · build \+ full suite\b/m);
  });

  it('uploads its report with an action on Node 24 (upload-artifact v4 ran on the deprecated Node 20)', () => {
    expect(job).toMatch(/uses:\s*actions\/upload-artifact@v7\b/);
  });

  it('exists and runs on a Windows runner', () => {
    expect(job).not.toBe('');
    expect(job).toMatch(/runs-on:\s*windows-latest/);
  });

  it('runs the whole suite (the root config), not the curated Windows subset', () => {
    expect(job).toMatch(/npx vitest run\b/);
    expect(job).not.toContain('vitest.windows.config');
    expect(job).not.toContain('test:windows');
  });

  // Eight, not four: four shards took ~20 min against Linux's ~13 (per shard ~2.5 min of
  // setup plus a quarter of ~57 min of tests, the heaviest shard ~25% over the mean).
  it('splits the suite into eight shards, and one red shard does not cancel the others', () => {
    expect(job).toMatch(/shard:\s*\[\s*1\s*,\s*2\s*,\s*3\s*,\s*4\s*,\s*5\s*,\s*6\s*,\s*7\s*,\s*8\s*\]/);
    expect(job).toMatch(/--shard[= ]\$\{\{\s*matrix\.shard\s*\}\}\/8/);
    expect(job).toMatch(/fail-fast:\s*false/);
  });

  it('builds every package the root suite reads from dist, not only the platform-sensitive ones', () => {
    expect(job).toMatch(/run:\s*npm run build\s*$/m);
  });

  it('is blocking: a Windows failure fails the workflow', () => {
    expect(job).not.toMatch(/continue-on-error/);
  });

  it('starts with the other jobs instead of waiting for them', () => {
    expect(job).not.toMatch(/^\s+needs:/m);
  });

  it('replaces the curated subset run, which the full suite contains', () => {
    expect(content).not.toMatch(/run:\s*npm run test:windows/);
    expect(content).not.toMatch(/run:.*vitest\.windows\.config/);
  });

  // "Windows compat" is a required status check on main ("Protect main branch"
  // ruleset): the name stays, and now means the whole suite passed on Windows.
  describe('the "Windows compat" required check', () => {
    const gate = jobBlock(content, 'windows-compat');

    it('keeps its check name, so the ruleset that requires it needs no change', () => {
      expect(gate).toMatch(/^\s+name:\s*Windows compat\s*$/m);
    });

    it('waits for every shard and reports even when one failed or was cancelled', () => {
      expect(gate).toMatch(/needs:\s*\[?\s*windows-full\s*\]?/);
      expect(gate).toMatch(/if:\s*\$\{\{\s*always\(\)\s*\}\}/);
    });

    it('passes only when the full-suite shards all succeeded', () => {
      expect(gate).toMatch(/needs\.windows-full\.result/);
      expect(gate).toMatch(/success/);
    });
  });

  // The server runs verify commands through cmd.exe with its own PATH. Under the job's Git
  // Bash PATH, cmd.exe also found MSYS touch/sleep in Git's usr/bin - a PATH a server started
  // from PowerShell, cmd or the desktop app does not have - so specs leaning on them were
  // green in CI and red for users (#208 branch review). The tests run without it.
  it("runs the suite under a native Windows PATH: Git's usr\\bin coreutils removed", () => {
    const step = job.slice(job.indexOf('- name: Test'), job.indexOf('- name: Home-integrity verify'));
    expect(step).toMatch(/shell:\s*pwsh/);
    expect(step).toMatch(/usr\\\\bin/i);
    expect(step).toMatch(/\$env:Path\s*=/);
  });

  it('runs under a HOME with a space and accents, as the subset job did (#201)', () => {
    expect(job).toMatch(/AGENFK_TEST_UNICODE_HOME:\s*'1'/);
  });

  it('proves the run left the real HOME untouched, as the subset job did', () => {
    const snapshot = job.indexOf('home-integrity.mjs snapshot');
    const test = job.indexOf('npx vitest run');
    const verify = job.indexOf('home-integrity.mjs verify');
    expect(snapshot).toBeGreaterThan(-1);
    expect(test).toBeGreaterThan(snapshot);
    expect(verify).toBeGreaterThan(test);
  });
});
