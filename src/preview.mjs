// Renders out/preview.html and out/preview.txt from a synthetic fixture, without calling env0.
// Usage: node src/preview.mjs [fixture.json]

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from './classify.mjs';
import { loadConfig } from './config.mjs';
import { OUT_DIR, writeOutputs } from './main.mjs';
import { render } from './render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = process.argv[2] ?? path.join(ROOT, 'test', 'fixtures', 'snapshot.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

// The fixture pins its own clock so durations are stable.
const now = new Date(fixture.now ?? Date.now());
const config = loadConfig(
  { REPORT_TIMEZONE: 'America/New_York', ENV0_APP_URL: 'https://app.example.com', ...process.env, ENV0_ORGANIZATION_ID: 'preview' },
  { requireOrganization: false },
);
const report = classify(fixture.snapshot, config, now);
const rendered = await render(report, config, now);
await writeOutputs(OUT_DIR, rendered, report, now, {
  htmlName: 'preview.html',
  textName: 'preview.txt',
  summaryName: 'preview-summary.json',
});
process.stdout.write(`Wrote out/preview.html (${Buffer.byteLength(rendered.html)} bytes): ${rendered.subject}\n`);
