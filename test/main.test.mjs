import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Env0Error, IncompleteDataError } from '../src/collect.mjs';
import { ConfigError, loadConfig } from '../src/config.mjs';
import { EXIT, assertComplete, exitCodeFor } from '../src/main.mjs';

test('exit codes: auth 2, incomplete 3, everything else 1', () => {
  assert.equal(exitCodeFor(new Env0Error(3, 'auth', 'x')), EXIT.AUTH);
  assert.equal(exitCodeFor(new IncompleteDataError('x')), EXIT.INCOMPLETE);
  assert.equal(exitCodeFor(new Env0Error(1, 'unknown', 'x')), EXIT.ERROR);
  assert.equal(exitCodeFor(new Env0Error(75, 'transient', 'x')), EXIT.ERROR);
  assert.equal(exitCodeFor(new ConfigError('x')), EXIT.ERROR);
});

test('a few failed lookups are tolerated; many are not', () => {
  const report = (failed, total) => ({ lookupFailures: { deployments: failed, templates: 0 }, counts: { totalActive: total } });
  assert.doesNotThrow(() => assertComplete(report(10, 100)));
  assert.throws(() => assertComplete(report(11, 100)), IncompleteDataError);
  assert.throws(() => assertComplete(report(1, 5)), IncompleteDataError);
  assert.doesNotThrow(() => assertComplete(report(0, 0)));
});

test('config defaults and validation', () => {
  const c = loadConfig({ ENV0_ORGANIZATION_ID: 'org' });
  assert.deepEqual(c, { organizationId: 'org', trackedBranch: 'main', timeZone: 'UTC', title: 'env0 daily status', maxRows: 50, appUrl: null });
  assert.throws(() => loadConfig({}), /ENV0_ORGANIZATION_ID/);
  assert.throws(() => loadConfig({ ENV0_ORGANIZATION_ID: 'o', REPORT_TIMEZONE: 'Mars/Base' }), /REPORT_TIMEZONE/);
  assert.throws(() => loadConfig({ ENV0_ORGANIZATION_ID: 'o', REPORT_MAX_ROWS: '0' }), /REPORT_MAX_ROWS/);
  assert.throws(() => loadConfig({ ENV0_ORGANIZATION_ID: 'o', ENV0_APP_URL: 'http://app.example.com' }), /https/);
  assert.equal(loadConfig({ ENV0_ORGANIZATION_ID: 'o', ENV0_APP_URL: 'https://app.example.com/' }).appUrl, 'https://app.example.com');
});
