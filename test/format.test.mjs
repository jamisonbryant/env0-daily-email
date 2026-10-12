import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  escapeHtml,
  formatDate,
  formatDateTime,
  formatDuration,
  repositoryPath,
  truncate,
} from '../src/format.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('formatDuration covers under a minute, minutes, hours, and days', () => {
  assert.equal(formatDuration(0), '<1m');
  assert.equal(formatDuration(59_999), '<1m');
  assert.equal(formatDuration(45 * MIN), '45m');
  assert.equal(formatDuration(3 * HOUR + 12 * MIN), '3h 12m');
  assert.equal(formatDuration(5 * HOUR), '5h');
  assert.equal(formatDuration(2 * DAY + 4 * HOUR + 30 * MIN), '2d 4h');
  assert.equal(formatDuration(3 * DAY), '3d');
  assert.equal(formatDuration(Number.NaN), '<1m');
});

test('escapeHtml escapes markup and quotes', () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml("a & b's"), 'a &amp; b&#39;s');
  assert.equal(escapeHtml(null), '');
});

test('truncate keeps short strings and shortens long ones', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcdefgh', 5), 'abcd…');
});

test('dates are rendered in the configured time zone', () => {
  // 03:30 UTC is still the previous day in New York.
  assert.equal(formatDate('2026-03-10T03:30:00Z', 'America/New_York'), 'Mar 9, 2026');
  assert.equal(formatDate('2026-03-10T03:30:00Z', 'UTC'), 'Mar 10, 2026');
  assert.match(formatDateTime('2026-07-01T16:05:00Z', 'America/New_York'), /Jul 1, 2026, 12:05\sPM EDT/);
  assert.equal(formatDate('not a date', 'UTC'), null);
});

test('repositoryPath strips scheme, host, credentials, and .git', () => {
  assert.equal(repositoryPath('https://git.example.com/acme-infra/network.git'), 'acme-infra/network');
  assert.equal(repositoryPath('https://user:token@git.example.com/acme-infra/network'), 'acme-infra/network');
  assert.equal(repositoryPath('git@git.example.com:acme-infra/network.git'), 'acme-infra/network');
  assert.equal(repositoryPath(''), null);
  assert.equal(repositoryPath(undefined), null);
});
