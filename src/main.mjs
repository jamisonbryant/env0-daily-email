// Builds the report: collect -> classify -> render -> write out/.
//
// Exit codes:
//   0  report built (out/email.html, out/email.txt, out/summary.json)
//   2  env0 authentication failure
//   3  data incomplete (truncated list, or too many per-environment lookups failed)
//   1  anything else
//
// Errors go to stderr as one line. Environment variables and request headers are never printed.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from './classify.mjs';
import { Env0Error, IncompleteDataError, collectSnapshot } from './collect.mjs';
import { ConfigError, loadConfig } from './config.mjs';
import { render } from './render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = path.join(ROOT, 'out');

/** Share of active environments whose lookups may fail before the run counts as incomplete. */
export const MAX_LOOKUP_FAILURE_RATIO = 0.1;

export const EXIT = Object.freeze({ OK: 0, ERROR: 1, AUTH: 2, INCOMPLETE: 3 });

export function exitCodeFor(error) {
  if (error instanceof Env0Error && error.isAuth) return EXIT.AUTH;
  if (error instanceof IncompleteDataError) return EXIT.INCOMPLETE;
  return EXIT.ERROR;
}

/** Throws IncompleteDataError if too many follow-up lookups failed to trust the report. */
export function assertComplete(report) {
  const failed = report.lookupFailures.deployments + report.lookupFailures.templates;
  const allowed = Math.floor(report.counts.totalActive * MAX_LOOKUP_FAILURE_RATIO);
  if (failed > allowed) {
    throw new IncompleteDataError(
      `${failed} of ${report.counts.totalActive} per-environment lookups failed (limit ${allowed}); report not built`,
    );
  }
}

/** Writes the three output files and returns the summary object. */
export async function writeOutputs(outDir, rendered, report, generatedAt, { htmlName = 'email.html', textName = 'email.txt', summaryName = 'summary.json' } = {}) {
  await mkdir(outDir, { recursive: true });
  const summary = {
    subject: rendered.subject,
    counts: report.counts,
    generatedAt: generatedAt.toISOString(),
    warnings: rendered.warnings,
  };
  await writeFile(path.join(outDir, htmlName), rendered.html);
  await writeFile(path.join(outDir, textName), rendered.text);
  await writeFile(path.join(outDir, summaryName), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

export async function main() {
  const config = loadConfig(process.env);
  const snapshot = await collectSnapshot({ organizationId: config.organizationId });
  const generatedAt = new Date();
  const report = classify(snapshot, config, generatedAt);
  assertComplete(report);
  const rendered = await render(report, config, generatedAt);
  const summary = await writeOutputs(OUT_DIR, rendered, report, generatedAt);
  process.stdout.write(
    `Report built: ${summary.subject} (${summary.counts.totalActive} active environments, ` +
      `${Buffer.byteLength(rendered.html)} bytes of HTML)\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(EXIT.OK),
    (error) => {
      const reason = error instanceof ConfigError ? `configuration error: ${error.message}` : error.message;
      process.stderr.write(`env0-daily-email: ${String(reason).replace(/\s+/g, ' ').trim()}\n`);
      process.exit(exitCodeFor(error));
    },
  );
}
