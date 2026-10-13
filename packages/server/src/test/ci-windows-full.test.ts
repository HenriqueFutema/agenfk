/**
 * #208 phase 6: the whole suite runs on Windows in CI, not only the curated
 * subset in vitest.windows.config.ts. A full local run on a managed Windows
 * box takes over an hour, so GitHub's runners are where it is checked, split
 * into shards so it costs minutes of wall-clock time.
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

  it('exists and runs on a Windows runner', () => {
    expect(job).not.toBe('');
    expect(job).toMatch(/runs-on:\s*windows-latest/);
  });

  it('runs the whole suite (the root config), not the curated Windows subset', () => {
    expect(job).toMatch(/npx vitest run\b/);
    expect(job).not.toContain('vitest.windows.config');
    expect(job).not.toContain('test:windows');
  });

  it('splits the suite into four shards, and one red shard does not cancel the others', () => {
    expect(job).toMatch(/shard:\s*\[\s*1\s*,\s*2\s*,\s*3\s*,\s*4\s*\]/);
    expect(job).toMatch(/--shard[= ]\$\{\{\s*matrix\.shard\s*\}\}\/4/);
    expect(job).toMatch(/fail-fast:\s*false/);
  });

  it('builds every package the root suite reads from dist, not only the platform-sensitive ones', () => {
    expect(job).toMatch(/run:\s*npm run build\s*$/m);
  });

  it('does not fail the workflow while the suite is not yet green on Windows', () => {
    expect(job).toMatch(/continue-on-error:\s*true/);
  });

  it('starts with the other jobs instead of waiting for them', () => {
    expect(job).not.toMatch(/^\s+needs:/m);
  });

  it('leaves the blocking Windows subset job in place until the full suite replaces it', () => {
    expect(jobBlock(content, 'windows-compat')).toContain('npm run test:windows');
  });
});
