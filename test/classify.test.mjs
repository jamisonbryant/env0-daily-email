import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildSubject,
  classify,
  isActiveEnvironment,
  normalizeRevision,
  projectPaths,
  requesterLabel,
  revisionKind,
} from '../src/classify.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/snapshot.json', import.meta.url), 'utf8'));
const NOW = new Date(fixture.now);
const CONFIG = { trackedBranch: 'main' };
const clone = () => structuredClone(fixture.snapshot);
const names = (rows) => rows.map((r) => r.name);
const byName = (rows, name) => rows.find((r) => r.name === name);

test('counts are true totals over active environments', () => {
  const r = classify(clone(), CONFIG, NOW);
  assert.deepEqual(r.counts, { waiting: 3, offBranch: 11, unknownRevision: 4, totalActive: 19 });
});

test('archived and inactive environments are excluded everywhere', () => {
  const r = classify(clone(), CONFIG, NOW);
  const all = [...r.waiting, ...r.offBranch, ...r.unknownRevision].map((x) => x.name);
  assert.ok(!all.includes('old-batch-jobs'), 'archived');
  assert.ok(!all.includes('retired-gateway'), 'inactive');
  assert.equal(isActiveEnvironment({ isArchived: true, status: 'ACTIVE' }), false);
  assert.equal(isActiveEnvironment({ isArchived: false, status: 'INACTIVE' }), false);
  assert.equal(isActiveEnvironment({ isArchived: false, status: 'NEVER_DEPLOYED' }), true);
});

test('revision equal to the tracked branch is not reported', () => {
  const r = classify(clone(), CONFIG, NOW);
  assert.ok(!names(r.offBranch).includes('billing-worker-prod'));
  assert.ok(!names(r.unknownRevision).includes('billing-worker-prod'));
});

test('different branch, tag-like string, short and full SHAs are off-branch with the right kind', () => {
  const r = classify(clone(), CONFIG, NOW);
  assert.equal(byName(r.offBranch, 'search-indexer-staging').kind, 'Branch or tag');
  assert.equal(byName(r.offBranch, 'analytics-etl-dev').kind, 'Branch or tag');
  assert.equal(byName(r.offBranch, 'edge-cache-prod').kind, 'Commit');
  assert.equal(byName(r.offBranch, 'reporting-db-prod').kind, 'Commit');
  assert.equal(revisionKind('a1b2c3'), 'Branch or tag', 'six hex chars is too short for a SHA');
  assert.equal(revisionKind('A1B2C3D'), 'Branch or tag', 'uppercase is not treated as a SHA');
  assert.equal(revisionKind('0123456789abcdef0123456789abcdef01234567'), 'Commit');
});

test('missing, null, and empty revisions are all unset', () => {
  assert.equal(normalizeRevision(undefined), null);
  assert.equal(normalizeRevision(null), null);
  assert.equal(normalizeRevision(''), null);
  assert.equal(normalizeRevision('   '), null);
  assert.equal(normalizeRevision('main'), 'main');
});

test('inherited template revision equal to the tracked branch is fine', () => {
  const r = classify(clone(), CONFIG, NOW);
  const all = [...r.offBranch, ...r.unknownRevision].map((x) => x.name);
  assert.ok(!all.includes('identity-api-staging'));
});

test('inherited template revision different from the tracked branch is off-branch (inherited)', () => {
  const r = classify(clone(), CONFIG, NOW);
  const row = byName(r.offBranch, 'queue-workers-dev');
  assert.equal(row.revision, 'develop');
  assert.equal(row.kind, 'Branch or tag (inherited)');
  assert.equal(row.inherited, true);
});

test('no revision anywhere stays in section C with the repository', () => {
  const r = classify(clone(), CONFIG, NOW);
  const row = byName(r.unknownRevision, 'docs-site-preview');
  assert.equal(row.reason, 'repository-default');
  assert.equal(row.repository, 'https://git.example.com/acme-infra/network.git');
  assert.equal(byName(r.unknownRevision, 'legacy-vpn').reason, 'no-deployment');
  assert.equal(byName(r.unknownRevision, 'mail-relay-prod').reason, 'unreadable');
  assert.equal(byName(r.unknownRevision, 'metrics-collector-prod').reason, 'unreadable');
});

test('failed lookups produce warnings', () => {
  const r = classify(clone(), CONFIG, NOW);
  assert.deepEqual(r.lookupFailures, { deployments: 1, templates: 1 });
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /latest deployment could not be read for 1 environment/);
});

test('waiting deploy vs waiting destroy', () => {
  const r = classify(clone(), CONFIG, NOW);
  const deploy = byName(r.waiting, 'payments-api-prod');
  const destroy = byName(r.waiting, 'network-shared');
  assert.equal(deploy.action, 'Deploy');
  assert.equal(deploy.isDestroy, false);
  assert.equal(destroy.action, 'Destroy');
  assert.equal(destroy.isDestroy, true);
});

test('waiting is sorted oldest first with correct durations', () => {
  const r = classify(clone(), CONFIG, NOW);
  assert.deepEqual(names(r.waiting), ['payments-api-prod', 'network-shared', 'search-indexer-staging']);
  assert.equal(r.waiting[0].waitedMs, (2 * 24 + 4) * 3_600_000);
  assert.equal(r.waiting[1].waitedMs, (3 * 60 + 12) * 60_000);
  assert.equal(r.waiting[2].waitedMs, 30_000);
});

test('requester falls back from name to email to Unknown', () => {
  assert.equal(requesterLabel({ name: 'Sample Person', email: 'sample@example.com' }), 'Sample Person');
  assert.equal(requesterLabel({ name: '', email: 'sample@example.com' }), 'sample@example.com');
  assert.equal(requesterLabel('sample@example.com'), 'sample@example.com');
  assert.equal(requesterLabel('env0-system'), 'Automatic (env0)');
  assert.equal(requesterLabel('idp|000000'), 'Unknown');
  assert.equal(requesterLabel(undefined), 'Unknown');
});

test('off-branch rows are sorted by project, then environment', () => {
  const r = classify(clone(), CONFIG, NOW);
  const keys = r.offBranch.map((x) => `${x.projectName}/${x.name}`);
  const sorted = [...keys].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  assert.deepEqual(keys, sorted);
});

test('project names fall back to the project ID', () => {
  const r = classify(clone(), CONFIG, NOW);
  assert.equal(byName(r.offBranch, 'orphan-service-dev').projectName, 'proj-unlisted');
  assert.equal(r.warnings.filter((w) => /Project names/.test(w)).length, 0);

  const snap = clone();
  snap.projects = null;
  const r2 = classify(snap, CONFIG, NOW);
  assert.equal(byName(r2.offBranch, 'edge-cache-prod').projectName, 'proj-platform');
  assert.match(r2.warnings[0], /Project names could not be loaded/);
});

test('sub-projects that share a name are shown with their parent path', () => {
  const r = classify(clone(), CONFIG, NOW);
  const rows = r.offBranch.filter((x) => x.name === 'shared/secrets').map((x) => x.projectName);
  assert.deepEqual(rows, ['Production / region-a', 'Staging / region-a']);
  assert.deepEqual(
    [...projectPaths([{ id: 'a', name: 'A', parentProjectId: 'b' }, { id: 'b', name: 'B', parentProjectId: 'a' }]).values()],
    ['B / A', 'A / B'],
    'cycles terminate',
  );
});

test('tracked branch is configurable', () => {
  const r = classify(clone(), { trackedBranch: 'develop' }, NOW);
  assert.ok(!names(r.offBranch).includes('queue-workers-dev'));
  assert.ok(names(r.offBranch).includes('billing-worker-prod'));
});

test('subject omits zero parts and says all clear when nothing is found', () => {
  assert.equal(buildSubject('env0 daily status', { waiting: 2, offBranch: 3 }, 'main'), 'env0 daily status: 2 awaiting approval · 3 off main');
  assert.equal(buildSubject('env0 daily status', { waiting: 0, offBranch: 3 }, 'main'), 'env0 daily status: 3 off main');
  assert.equal(buildSubject('env0 daily status', { waiting: 1, offBranch: 0 }, 'main'), 'env0 daily status: 1 awaiting approval');
  assert.equal(buildSubject('Status', { waiting: 0, offBranch: 0 }, 'main'), 'Status: all clear');
});
