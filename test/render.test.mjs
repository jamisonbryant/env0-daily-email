import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { classify } from '../src/classify.mjs';
import { HTML_SIZE_LIMIT, buildMjml, buildText, render } from '../src/render.mjs';
import { buildLargeSnapshot } from './fixtures/large.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/snapshot.json', import.meta.url), 'utf8'));
const NOW = new Date(fixture.now);
const CONFIG = {
  trackedBranch: 'main',
  timeZone: 'America/New_York',
  title: 'env0 daily status',
  maxRows: 50,
  appUrl: null,
};
const report = (snapshot = structuredClone(fixture.snapshot), config = CONFIG) => classify(snapshot, config, NOW);

test('hostile names and revisions are escaped in the HTML', async () => {
  const { html } = await render(report(), CONFIG, NOW);
  assert.ok(!html.includes('<script>alert'), 'raw script tag');
  assert.ok(!html.includes('<img src=x'), 'raw img tag');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;-prod'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('compiled HTML has no external resources or scripts', async () => {
  const { html } = await render(report(), CONFIG, NOW);
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<img/i.test(html));
  assert.ok(!/<link[^>]+stylesheet/i.test(html));
  assert.ok(!/@import|url\(/i.test(html));
});

test('section content, labels, and footer are present', async () => {
  const { html, text, subject } = await render(report(), CONFIG, NOW);
  assert.equal(subject, 'env0 daily status: 3 awaiting approval · 11 off main');
  for (const s of ['Waiting for approval', 'Not tracking main', 'No revision set', 'Destroy', 'Branch or tag (inherited)', 'acme-infra/network', 'Source: env0 API', 'workflow sub-environments not included', 'This is an automated report.', 'America/New_York']) {
    assert.ok(html.includes(s), `html has ${s}`);
    assert.ok(text.toLowerCase().includes(s.toLowerCase()), `text has ${s}`);
  }
  assert.ok(html.includes('2d 4h') && text.includes('waiting 2d 4h (over 24h)'));
  assert.ok(text.includes('[DESTROY]'));
  assert.ok(text.includes("These follow their repository's default branch, which this report can't confirm is main."));
});

test('no links are rendered unless ENV0_APP_URL is configured', async () => {
  const plain = await render(report(), CONFIG, NOW);
  assert.ok(!/href=/i.test(plain.html));
  assert.ok(!/https?:\/\//.test(plain.text));

  const linked = await render(report(), { ...CONFIG, appUrl: 'https://app.example.com' }, NOW);
  assert.ok(linked.html.includes('href="https://app.example.com/p/proj-payments/environments/env-01/deployments/dep-01"'));
  assert.ok(linked.html.includes('href="https://app.example.com/p/proj-data/environments/env-05"'));
  assert.ok(linked.text.includes('https://app.example.com/p/proj-platform/environments/env-02/deployments/dep-02'));
});

test('row cap shows "and N more" while summary counts stay true totals', () => {
  const config = { ...CONFIG, maxRows: 2 };
  const r = report(undefined, config);
  const mjml = buildMjml(r, config, NOW);
  const text = buildText(r, config, NOW);
  assert.ok(mjml.includes('And 1 more not shown.'), 'waiting overflow');
  assert.ok(mjml.includes('And 9 more not shown.'), 'off-branch overflow');
  assert.ok(mjml.includes('And 2 more not shown.'), 'unknown overflow');
  assert.ok(text.includes('And 9 more not shown.'));
  assert.match(mjml, />3<\/div><div[^>]*>Awaiting approval/);
  assert.match(mjml, />11<\/div><div[^>]*>Not tracking main/);
  assert.match(text, /^3 awaiting approval · 11 not tracking main · 4 no revision set$/m);
  // Rows rendered: 2 per section.
  assert.equal((mjml.match(/<tr valign="top"><td/g) ?? []).length, 6);
});

test('all-clear output keeps every section with a one-line message', async () => {
  const snap = structuredClone(fixture.snapshot);
  snap.environments = snap.environments.filter((e) => ['billing-worker-prod', 'identity-api-staging'].includes(e.name));
  const r = report(snap);
  assert.deepEqual(r.counts, { waiting: 0, offBranch: 0, unknownRevision: 0, totalActive: 2 });
  const { html, text, subject } = await render(r, CONFIG, NOW);
  assert.equal(subject, 'env0 daily status: all clear');
  for (const s of ['No deployments are waiting for approval.', 'Every environment with a known revision tracks main.', 'Every environment has a revision this report could check.']) {
    assert.ok(html.includes(s), s);
    assert.ok(text.includes(s), s);
  }
});

test('300-environment fixture stays under 90 KB, trimming rows only as needed', async () => {
  assert.equal(HTML_SIZE_LIMIT, 90_000);
  const config = { ...CONFIG, appUrl: 'https://app.example.com' };
  const r = classify(buildLargeSnapshot(300, NOW), config, NOW);
  assert.deepEqual(r.counts, { waiting: 100, offBranch: 200, unknownRevision: 100, totalActive: 300 });
  const out = await render(r, config, NOW);
  const size = Buffer.byteLength(out.html);
  assert.ok(size <= HTML_SIZE_LIMIT, `HTML is ${size} bytes`);
  // True totals are still shown, and the overflow lines match the rows actually listed.
  assert.ok(out.html.includes(`And ${100 - out.maxRows} more not shown.`));
  assert.ok(out.html.includes(`And ${200 - out.maxRows} more not shown.`));
  assert.match(out.text, /^100 awaiting approval · 200 not tracking main · 100 no revision set$/m);
  if (out.maxRows < config.maxRows) {
    assert.ok(out.warnings.some((w) => w.includes(`at most ${out.maxRows} rows`)));
    assert.ok(out.html.includes(`at most ${out.maxRows} rows`));
  }
});

test('a report that fits is never trimmed', async () => {
  const out = await render(report(), CONFIG, NOW);
  assert.equal(out.maxRows, 50);
  assert.ok(!out.warnings.some((w) => /size limit/.test(w)));
});
