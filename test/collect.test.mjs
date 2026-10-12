import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Env0Error, IncompleteDataError, collectSnapshot, mapLimit, runEnv0 } from '../src/collect.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-env0.mjs', import.meta.url));

function withMode(mode, fn) {
  const prev = process.env.FAKE_ENV0_MODE;
  process.env.FAKE_ENV0_MODE = mode;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.FAKE_ENV0_MODE;
    else process.env.FAKE_ENV0_MODE = prev;
  });
}

test('runEnv0 parses the success envelope and passes arguments without a shell', () =>
  withMode('ok', async () => {
    const res = await runEnv0(['deployment', 'get', 'dep-1; echo injected', '-o', 'compact'], { bin: FAKE });
    assert.deepEqual(res.data.args, ['deployment', 'get', 'dep-1; echo injected', '-o', 'compact']);
  }));

test('runEnv0 maps an auth failure to an auth Env0Error', () =>
  withMode('auth', async () => {
    await assert.rejects(runEnv0(['environment', 'list'], { bin: FAKE }), (e) => {
      assert.ok(e instanceof Env0Error);
      assert.equal(e.exitCode, 3);
      assert.equal(e.isAuth, true);
      assert.match(e.message, /missing credentials/);
      return true;
    });
  }));

test('runEnv0 reports non-envelope output and plain failures', async () => {
  await withMode('garbage', () => assert.rejects(runEnv0(['template', 'get', 'x'], { bin: FAKE }), /not a JSON envelope/));
  await withMode('fail', () => assert.rejects(runEnv0(['template', 'get', 'x'], { bin: FAKE }), /plain failure text/));
});

test('runEnv0 refuses anything outside the read-only allowlist', async () => {
  for (const args of [['environment', 'deploy', 'x'], ['deployment', 'approve', 'x'], ['environment', 'destroy', 'x', '--yes'], ['api-key', 'create']]) {
    await assert.rejects(runEnv0(args, { bin: FAKE }), /read-only allowlist/);
  }
});

test('mapLimit respects the concurrency limit and keeps order', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(peak <= 3);
});

function fakeRun(responses, calls = []) {
  return async (args) => {
    calls.push(args.join(' '));
    const key = args.slice(0, 3).join(' ');
    const r = responses[key] ?? responses[args.slice(0, 2).join(' ')];
    if (r instanceof Error) throw r;
    if (!r) throw new Error(`unexpected call ${key}`);
    return r;
  };
}

const ENVS = [
  { id: 'env-1', name: 'a', projectId: 'p', status: 'ACTIVE', isArchived: false, latestDeployment: { id: 'dep-1', status: 'SUCCESS' } },
  { id: 'env-2', name: 'b', projectId: 'p', status: 'ACTIVE', isArchived: false, latestDeployment: { id: 'dep-2', status: 'SUCCESS' } },
  { id: 'env-3', name: 'c', projectId: 'p', status: 'ACTIVE', isArchived: true, latestDeployment: { id: 'dep-3', status: 'SUCCESS' } },
  { id: 'env-4', name: 'd', projectId: 'p', status: 'ACTIVE', isArchived: false, latestDeployment: null },
];

test('collectSnapshot fails on a truncated list', async () => {
  const run = fakeRun({ 'environment list': { data: ENVS, page: { truncated: true, nextOffset: 100 } } });
  await assert.rejects(collectSnapshot({ organizationId: 'org', run }), IncompleteDataError);
});

test('collectSnapshot only looks up active environments and only fetches templates when needed', async () => {
  const calls = [];
  const run = fakeRun(
    {
      'environment list': { data: ENVS, page: { truncated: false } },
      'project list': new Env0Error(3, 'auth', 'forbidden'),
      'deployment get dep-1': { data: { id: 'dep-1', blueprintId: 'tpl-a', blueprintRevision: 'main' } },
      'deployment get dep-2': { data: { id: 'dep-2', blueprintId: 'tpl-b' } },
      'template get tpl-b': new Env0Error(4, 'not_found', 'gone'),
    },
    calls,
  );
  const snap = await collectSnapshot({ organizationId: 'org', run });
  assert.equal(snap.projects, null);
  assert.deepEqual(Object.keys(snap.deployments).sort(), ['dep-1', 'dep-2']);
  assert.ok(!calls.some((c) => c.includes('dep-3')), 'archived environment not queried');
  assert.ok(!calls.some((c) => c.includes('tpl-a')), 'template not needed when revision is set');
  assert.deepEqual(Object.keys(snap.failures.templates), ['tpl-b']);
  assert.ok(calls.every((c) => /^(environment list|project list|deployment get|template get)/.test(c)));
});

test('collectSnapshot records failed deployment lookups instead of aborting', async () => {
  const run = fakeRun({
    'environment list': { data: ENVS, page: { truncated: false } },
    'project list': { data: [] },
    'deployment get dep-1': new Env0Error(1, 'unknown', 'decode error'),
    'deployment get dep-2': { data: { id: 'dep-2', blueprintRevision: 'main' } },
  });
  const snap = await collectSnapshot({ organizationId: 'org', run });
  assert.match(snap.failures.deployments['dep-1'], /decode error/);
  assert.ok(snap.deployments['dep-2']);
});

test('collectSnapshot surfaces an auth failure on the list', async () => {
  const run = fakeRun({ 'environment list': new Env0Error(3, 'auth', 'bad key') });
  await assert.rejects(collectSnapshot({ organizationId: 'org', run }), (e) => e.isAuth);
});
