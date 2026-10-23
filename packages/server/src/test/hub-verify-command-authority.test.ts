/**
 * The hub's verify command is authoritative (RFC-002, client side).
 *
 * A project that carries `hubRepoSettings` runs the HUB's command at the final
 * gate - not the repository file's, not the stored one - the hub's command is
 * refused when it holds characters a screen cannot show faithfully, and
 * PUT /projects/:id/verify-command refuses a command that is not the hub's.
 * A project without hub settings behaves exactly as before (the regression
 * guards here).
 *
 * The harness is the one file-verify-command-no-approval.test.ts uses: the real
 * app, a git repository per test, and a marker file proving which command ran.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = testDbPath('hub-verify-command-authority-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, storage, VERIFY_TOKEN } from '../server';
import { posixShell } from './helpers/posixShell';
import { nodeCommand } from './helpers/nodeCommand';

let __server: import('http').Server;
const agent = () => request(__server);
const repos: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(async () => {
  await removeTestDb(TEST_DB, closeStorage);
  for (const r of repos) fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Node, not touch/printf: the server runs it with sh off Windows and cmd.exe on it (#208).
const mark = (marker: string) => nodeCommand(`require('fs').writeFileSync(${JSON.stringify(marker)}, '');`);

/** A committed repository whose .agenfk/project.json declares `verifyCommand`. */
function repoDeclaring(verifyCommand: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hubverify-'));
  repos.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir, shell: posixShell() });
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'test');
  fs.mkdirSync(path.join(dir, '.agenfk'));
  fs.writeFileSync(path.join(dir, '.agenfk', 'project.json'), JSON.stringify({ verifyCommand }));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'report.*\nFILE_RAN\nHUB_RAN\nSTORED_RAN\n');
  execSync('git add . && git commit -qm one', { cwd: dir, shell: posixShell() });
  return dir;
}

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
async function flow(steps: any[], extra: Record<string, unknown> = {}): Promise<string> {
  const res = await agent().post('/flows').send({ name: `hubverify-${++seq}`, steps, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}
async function project(flowId: string, extra: Record<string, unknown>) {
  const p = await agent().post('/projects').send({ name: `hubverify-${++seq}` });
  await storage.updateProject(p.body.id, { flowId, ...extra } as never);
  return p.body.id as string;
}
async function card(projectId: string, status: string, extra: Record<string, unknown> = {}) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `card-${++seq}`, projectId });
  await storage.updateItem(c.body.id, { status, ...extra } as any);
  return c.body.id as string;
}
const validate = (id: string, body: Record<string, unknown> = {}) =>
  agent().post(`/items/${id}/validate`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ evidence: 'ok', ...body });

const twoSteps = () => flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })]);

/** Settings as the sync would have stored them. */
const hubSettings = (verifyCommand: string, over: Record<string, unknown> = {}) => ({
  remoteUrl: 'git@github.com:acme/widget.git',
  verifyCommand,
  revision: 4,
  receiptsMode: 'off',
  shadowThreshold: null,
  producers: [],
  syncedAt: new Date().toISOString(),
  ...over,
});

describe('the hub command runs at the final verify', () => {
  it('runs the hub command, not the repository file command, and closes the card', async () => {
    const dir = repoDeclaring(mark('FILE_RAN'));
    const pid = await project(await twoSteps(), { projectRoot: dir, verifyCommand: mark('STORED_RAN') });
    await storage.updateProject(pid, { hubRepoSettings: hubSettings(mark('HUB_RAN')) } as any);
    const id = await card(pid, 'WORK');

    const res = await validate(id);
    expect(res.body.error, JSON.stringify(res.body)).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'HUB_RAN'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'FILE_RAN'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'STORED_RAN'))).toBe(false);
    expect((await storage.getItem(id))?.status).toBe('END');
  });

  it('with no hub settings the file command still runs (regression)', async () => {
    const dir = repoDeclaring(mark('FILE_RAN'));
    const pid = await project(await twoSteps(), { projectRoot: dir, verifyCommand: mark('STORED_RAN') });
    const id = await card(pid, 'WORK');

    const res = await validate(id);
    expect(res.body.error, JSON.stringify(res.body)).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'FILE_RAN'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'HUB_RAN'))).toBe(false);
    expect((await storage.getItem(id))?.status).toBe('END');
  });

  it('a hub command holding a hidden character is refused and nothing runs', async () => {
    const dir = repoDeclaring(mark('FILE_RAN'));
    const pid = await project(await twoSteps(), { projectRoot: dir });
    await storage.updateProject(pid, { hubRepoSettings: hubSettings(`${mark('HUB_RAN')} \u200B`) } as any);
    const id = await card(pid, 'WORK');

    const res = await validate(id);
    expect(res.body.error, JSON.stringify(res.body)).toBe('COMMAND_UNREADABLE');
    expect(String(res.body.message)).toContain('U+200B');
    expect(fs.existsSync(path.join(dir, 'HUB_RAN'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'FILE_RAN'))).toBe(false);
    expect((await storage.getItem(id))?.status).toBe('WORK');
  });
});

describe('PUT /projects/:id/verify-command defers to the hub', () => {
  const setCommand = (pid: string, verifyCommand: string) =>
    agent().put(`/projects/${pid}/verify-command`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ verifyCommand });

  it('refuses a command that is not the hub, and changes nothing', async () => {
    const hubCommand = mark('HUB_RAN');
    const pid = await project(await twoSteps(), { verifyCommand: 'the-stored-command' });
    await storage.updateProject(pid, { hubRepoSettings: hubSettings(hubCommand, { revision: 11 }) } as any);

    const res = await setCommand(pid, 'npm run test:fast');
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe('HUB_OWNS_VERIFY_COMMAND');
    expect(String(res.body.message)).toContain('11');
    expect(((await storage.getProject(pid)) as any).verifyCommand).toBe('the-stored-command');
  });

  it('accepts the command that IS the hub', async () => {
    const hubCommand = mark('HUB_RAN');
    const pid = await project(await twoSteps(), { verifyCommand: 'the-stored-command' });
    await storage.updateProject(pid, { hubRepoSettings: hubSettings(hubCommand) } as any);

    const res = await setCommand(pid, hubCommand);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(((await storage.getProject(pid)) as any).verifyCommand).toBe(hubCommand);
  });

  it('a project without hub settings still accepts any command (regression)', async () => {
    const pid = await project(await twoSteps(), { verifyCommand: 'the-stored-command' });
    const res = await setCommand(pid, 'npm run test:fast');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(((await storage.getProject(pid)) as any).verifyCommand).toBe('npm run test:fast');
  });
});
