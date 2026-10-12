// Renders classified report data to MJML, compiles it to HTML with the mjml CLI,
// and builds the plain-text alternative.
//
// Every API-sourced string goes through escapeHtml before it is
// placed in markup. Template tokens are substituted in a single pass, so values are
// never re-scanned for tokens.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSubject } from './classify.mjs';
import {
  escapeHtml,
  formatDate,
  formatDateTime,
  formatAge,
  formatDuration,
  formatLongDate,
  truncate,
} from './format.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = path.join(ROOT, 'templates');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REVISION_CHARS = 48;

const C = {
  text: '#1d2430',
  muted: '#5b6573',
  rule: '#e3e6ea',
  accent: '#1f5a96',
  caution: '#a14a00',
  destroyText: '#a8241b',
  destroyBg: '#fbeaea',
  destroyBorder: '#efc2bd',
  figureBg: '#f5f6f8',
};
const MONO = 'Menlo,Consolas,monospace';
const MONO_VALUE = `font-family:${MONO};font-size:13px;word-break:break-all`;

const SCOPE_NOTE = 'Active environments only; workflow sub-environments not included.';
const AUTOMATED_NOTE = 'This is an automated report.';
const SOURCE_NOTE = 'Source: env0 API';

function fill(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

function readTemplate(name) {
  return readFileSync(path.join(TEMPLATES, name), 'utf8');
}

/** Builds web-app links only when a base URL is configured. */
export function linkBuilder(appUrl) {
  if (!appUrl) return { environment: () => null, deployment: () => null };
  const base = appUrl.replace(/\/+$/, '');
  const enc = encodeURIComponent;
  const environment = (row) =>
    row.projectId && row.id ? `${base}/p/${enc(row.projectId)}/environments/${enc(row.id)}` : null;
  return {
    environment,
    deployment: (row) => {
      const env = environment(row);
      return env && row.deploymentId ? `${env}/deployments/${enc(row.deploymentId)}` : env;
    },
  };
}

// ---- HTML pieces -----------------------------------------------------------
// Row markup is kept compact: Gmail clips messages near 102 KB, and every style
// must be inline. Rows set valign once on <tr>; cells carry only padding and rule.

const CELL = `padding:10px 12px 10px 0;border-bottom:1px solid ${C.rule}`;
const LAST_CELL = `padding:10px 0;border-bottom:1px solid ${C.rule}`;
const HEAD_CELL = `padding:0 12px 6px 0;border-bottom:1px solid ${C.rule};color:${C.muted};font-size:12px;font-weight:600`;
const SUB = `color:${C.muted};font-size:12px`;
const LINK = `color:${C.accent};text-decoration:none`;

/** A monospace value, truncated for display with the full value in a title attribute. */
function monoValue(value, max) {
  const shown = truncate(value, max);
  const title = shown === value ? '' : ` title="${escapeHtml(value)}"`;
  return `<div${title} style="${MONO_VALUE}">${escapeHtml(shown)}</div>`;
}

function nameCell(row, href, secondary, badge = '') {
  const name = escapeHtml(row.name);
  const label = href ? `<a href="${escapeHtml(href)}" style="${LINK}">${name}</a>` : name;
  return `<td style="${CELL};word-break:break-word"><b>${label}</b>${badge}<div style="${SUB}">${secondary}</div></td>`;
}

function table(headers, rows) {
  const head = headers
    .map(([label, align, width], i) => {
      const w = width ? ` width="${width}"` : '';
      const pad = i === headers.length - 1 ? ';padding-right:0' : '';
      return `<th${w} style="${HEAD_CELL};text-align:${align}${pad}">${label}</th>`;
    })
    .join('');
  return `<mj-table table-layout="fixed"><tr>${head}</tr>${rows.join('')}</mj-table>`;
}

function emptyNote(text) {
  return `<mj-text padding="2px 0 4px">${escapeHtml(text)}</mj-text>`;
}

function overflowNote(total, shown) {
  if (total <= shown) return '';
  return `<mj-text color="${C.muted}" font-size="13px" padding="10px 0 0">And ${total - shown} more not shown.</mj-text>`;
}

const DESTROY_LABEL =
  ` <span style="padding:0 5px;border:1px solid ${C.destroyBorder};border-radius:3px;background:${C.destroyBg};` +
  `color:${C.destroyText};font-size:12px;font-weight:600;white-space:nowrap">Destroy</span>`;

/** Right-aligned duration cell, highlighted in the caution color when over 24 hours. */
function ageCell(ms, text, title = '') {
  const over = ms != null && ms > DAY_MS;
  const t = title ? ` title="${escapeHtml(title)}"` : '';
  return (
    `<td${t} style="${LAST_CELL};text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums` +
    `${over ? `;color:${C.caution};font-weight:600` : ''}">${escapeHtml(text)}</td>`
  );
}

function waitingRows(rows, links) {
  return rows.map((r) => {
    const waited = r.waitedMs == null ? 'Unknown' : formatDuration(r.waitedMs);
    return (
      `<tr valign="top">${nameCell(r, links.deployment(r), escapeHtml(r.projectName), r.isDestroy ? DESTROY_LABEL : '')}` +
      `${ageCell(r.waitedMs, waited)}</tr>`
    );
  });
}

const SOURCE_NOTES = { template: 'From template', 'repository-default': 'Repository default' };

function offBranchRows(rows, links, timeZone) {
  return rows.map((r) => {
    const note = SOURCE_NOTES[r.source] ? `<div style="${SUB}">${SOURCE_NOTES[r.source]}</div>` : '';
    const age = r.lastDeployedAt ? formatAge(r.sinceMs) : 'Never';
    const date = r.lastDeployedAt ? formatDate(r.lastDeployedAt, timeZone) ?? '' : '';
    return (
      `<tr valign="top">${nameCell(r, links.environment(r), escapeHtml(r.projectName))}` +
      `<td style="${CELL}">${monoValue(r.revision, MAX_REVISION_CHARS)}${note}</td>${ageCell(r.sinceMs, age, date)}</tr>`
    );
  });
}

const UNCHECKED_REASONS = {
  'no-deployment': 'No deployment record',
  unreadable: 'Lookup failed',
};

function unknownRows(rows, links) {
  return rows.map(
    (r) =>
      `<tr valign="top">${nameCell(r, links.environment(r), escapeHtml(r.projectName))}` +
      `<td style="${LAST_CELL};color:${C.muted}">${UNCHECKED_REASONS[r.reason] ?? 'Unknown'}</td></tr>`,
  );
}

function sectionHeading(title, count) {
  return `${escapeHtml(title)} <span style="color:${C.muted};font-weight:400">&middot; ${count}</span>`;
}

function code(text) {
  return `<span style="font-family:${MONO};font-size:13px">${escapeHtml(text)}</span>`;
}

// ---- Public API ------------------------------------------------------------

/** Text pieces shared by the HTML and plain-text renderings. */
export function describe(report, config, generatedAt) {
  const { counts, trackedBranch } = report;
  const subject = buildSubject(config.title, counts, trackedBranch);
  const preheader =
    `${counts.waiting} awaiting approval, ${counts.offBranch} not tracking ${trackedBranch}, ` +
    `${counts.unknownRevision} could not be checked, across ${counts.totalActive} active environments.`;
  return {
    subject,
    preheader,
    dateLine: formatLongDate(generatedAt, config.timeZone),
    generated: `Generated ${formatDateTime(generatedAt, config.timeZone)} (${config.timeZone})`,
  };
}

/** Builds the full MJML document. */
export function buildMjml(report, config, generatedAt) {
  const d = describe(report, config, generatedAt);
  const links = linkBuilder(config.appUrl);
  const max = config.maxRows;
  const branch = report.trackedBranch;
  const section = readTemplate('section.mjml');

  const figures = [
    [report.counts.waiting, 'Awaiting approval'],
    [report.counts.offBranch, `Not tracking ${branch}`],
    [report.counts.unknownRevision, 'Could not be checked'],
  ]
    .map(
      ([n, label]) =>
        `<mj-column width="33.33%" padding="0 6px"><mj-text container-background-color="${C.figureBg}" padding="12px 12px 10px">` +
        `<div style="font-size:26px;line-height:32px;font-weight:600;font-variant-numeric:tabular-nums">${n}</div>` +
        `<div style="color:${C.muted};font-size:12px;line-height:16px">${escapeHtml(label)}</div></mj-text></mj-column>`,
    )
    .join('');

  const a = report.waiting;
  const sectionA = fill(section, {
    HEADING: sectionHeading('Waiting for approval', a.length),
    DESCRIPTION: 'Deployments paused until someone approves them, oldest first. Waits over 24 hours are highlighted.',
    BODY: a.length
      ? table([['Environment', 'left'], ['Waiting', 'right', 80]], waitingRows(a.slice(0, max), links)) +
        overflowNote(a.length, max)
      : emptyNote('No deployments are waiting for approval.'),
  });

  const b = report.offBranch;
  const sectionB = fill(section, {
    HEADING: sectionHeading(`Not tracking ${branch}`, b.length),
    DESCRIPTION:
      `Environments set to deploy a revision other than ${code(branch)}, by project. ` +
      'Deployments more than 24 hours old are highlighted.',
    BODY: b.length
      ? table(
          [['Environment', 'left'], ['Revision', 'left', '30%'], ['Last deployed', 'right', 92]],
          offBranchRows(b.slice(0, max), links, config.timeZone),
        ) + overflowNote(b.length, max)
      : emptyNote(`Every checked environment tracks ${branch}.`),
  });

  const c = report.unknownRevision;
  const sectionC = fill(section, {
    HEADING: sectionHeading('Could not be checked', c.length),
    DESCRIPTION: 'env0 returned no readable deployment for these environments, so the branch they deploy is unknown.',
    BODY: c.length
      ? table([['Environment', 'left'], ['Reason', 'left', '36%']], unknownRows(c.slice(0, max), links)) +
        overflowNote(c.length, max)
      : emptyNote('Every active environment was checked.'),
  });

  const footerLines = [
    `${escapeHtml(d.generated)} &middot; ${escapeHtml(SOURCE_NOTE)}`,
    `${escapeHtml(SCOPE_NOTE)} ${report.counts.totalActive} active environments checked.`,
  ];
  if (report.warnings.length) {
    footerLines.push(
      `<span style="color:${C.text};font-weight:600">Notes:</span> ` + report.warnings.map(escapeHtml).join(' '),
    );
  }
  footerLines.push(escapeHtml(AUTOMATED_NOTE));

  return fill(readTemplate('report.mjml'), {
    SUBJECT: escapeHtml(d.subject),
    PREHEADER: escapeHtml(d.preheader),
    TITLE: escapeHtml(config.title),
    DATE_LINE: `${escapeHtml(d.dateLine)} &middot; Target branch ${code(branch)}`,
    SUMMARY: figures,
    SECTIONS: sectionA + sectionB + sectionC,
    FOOTER: footerLines.join('<br />'),
  });
}

function mjmlBinary() {
  const local = path.join(ROOT, 'node_modules', '.bin', 'mjml');
  return existsSync(local) ? local : 'mjml';
}

/** Compiles MJML to HTML with strict validation. Rejects on any error or warning. */
export function compileMjml(mjml, { bin = process.env.MJML_BIN || mjmlBinary() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ['-i', '-s', '--noStdoutFileComment', '--config.validationLevel', 'strict', '--config.minify', 'true'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) =>
      reject(new Error(e.code === 'ENOENT' ? 'mjml CLI not found (install it globally or run npm ci)' : e.message)),
    );
    child.on('close', (codeNum) => {
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (codeNum !== 0 || stderr) {
        reject(new Error(`mjml compile failed (exit ${codeNum}): ${stderr.replace(/\s+/g, ' ').slice(0, 500)}`));
        return;
      }
      resolve(Buffer.concat(out).toString('utf8'));
    });
    child.stdin.end(mjml);
  });
}

// ---- Plain text ------------------------------------------------------------

function heading(text) {
  return `${text.toUpperCase()}\n${'-'.repeat(text.length)}`;
}

/** Builds the plain-text alternative with the same content as the HTML. */
export function buildText(report, config, generatedAt) {
  const d = describe(report, config, generatedAt);
  const links = linkBuilder(config.appUrl);
  const max = config.maxRows;
  const branch = report.trackedBranch;
  const { counts } = report;
  const out = [];

  out.push(config.title, `${d.dateLine} · Target branch: ${branch}`, '');
  out.push(
    `${counts.waiting} awaiting approval · ${counts.offBranch} not tracking ${branch} · ${counts.unknownRevision} could not be checked`,
    '',
  );

  const more = (total) => (total > max ? [`  And ${total - max} more not shown.`] : []);

  out.push(heading(`Waiting for approval (${counts.waiting})`));
  if (!report.waiting.length) out.push('No deployments are waiting for approval.');
  for (const r of report.waiting.slice(0, max)) {
    const waited = r.waitedMs == null ? 'unknown' : formatDuration(r.waitedMs);
    const flag = r.waitedMs != null && r.waitedMs > DAY_MS ? ' (over 24h)' : '';
    out.push(`- ${r.name}${r.isDestroy ? '  [DESTROY]' : ''}`);
    out.push(`  ${r.projectName} · waiting ${waited}${flag}`);
    const href = links.deployment(r);
    if (href) out.push(`  ${href}`);
  }
  out.push(...more(report.waiting.length), '');

  out.push(heading(`Not tracking ${branch} (${counts.offBranch})`));
  if (!report.offBranch.length) out.push(`Every checked environment tracks ${branch}.`);
  for (const r of report.offBranch.slice(0, max)) {
    const deployed = r.lastDeployedAt ? `${formatAge(r.sinceMs)} (${formatDate(r.lastDeployedAt, config.timeZone)})` : 'never';
    const note = SOURCE_NOTES[r.source] ? ` (${SOURCE_NOTES[r.source].toLowerCase()})` : '';
    out.push(`- ${r.name}`);
    out.push(`  ${r.projectName} · ${r.revision}${note} · last deployed ${deployed}`);
    const href = links.environment(r);
    if (href) out.push(`  ${href}`);
  }
  out.push(...more(report.offBranch.length), '');

  out.push(heading(`Could not be checked (${counts.unknownRevision})`));
  if (!report.unknownRevision.length) out.push('Every active environment was checked.');
  else out.push('env0 returned no readable deployment for these environments, so the branch they deploy is unknown.');
  for (const r of report.unknownRevision.slice(0, max)) {
    out.push(`- ${r.name}`);
    out.push(`  ${r.projectName} · ${(UNCHECKED_REASONS[r.reason] ?? 'Unknown').toLowerCase()}`);
    const href = links.environment(r);
    if (href) out.push(`  ${href}`);
  }
  out.push(...more(report.unknownRevision.length), '');

  out.push('--', `${d.generated} · ${SOURCE_NOTE}`, `${SCOPE_NOTE} ${counts.totalActive} active environments checked.`);
  if (report.warnings.length) out.push(`Notes: ${report.warnings.join(' ')}`);
  out.push(AUTOMATED_NOTE, '');
  return out.join('\n');
}

/** Upper bound for the compiled HTML. Gmail clips messages at about 102 KB. */
export const HTML_SIZE_LIMIT = 90_000;
const MIN_ROWS = 5;
// Approximate size of the compiled layout with no rows; used only to estimate a smaller cap.
const LAYOUT_BYTES = 24 * 1024;

/**
 * Renders everything: subject, MJML, compiled HTML, and plain text.
 * If the HTML would exceed HTML_SIZE_LIMIT, the per-section row cap is lowered until it
 * fits, and a note saying so is added. Counts always remain true totals.
 */
export async function render(report, config, generatedAt) {
  let maxRows = config.maxRows;
  let current = report;
  for (;;) {
    const cfg = { ...config, maxRows };
    const mjml = buildMjml(current, cfg, generatedAt);
    const html = await compileMjml(mjml);
    const size = Buffer.byteLength(html);
    if (size <= HTML_SIZE_LIMIT) {
      return {
        subject: describe(current, cfg, generatedAt).subject,
        mjml,
        html,
        text: buildText(current, cfg, generatedAt),
        warnings: current.warnings,
        maxRows,
      };
    }
    if (maxRows <= MIN_ROWS) {
      throw new Error(`report HTML is ${size} bytes, over the ${HTML_SIZE_LIMIT}-byte limit even at ${maxRows} rows per section`);
    }
    // Scale the cap by the space left after the fixed layout, then verify by compiling again.
    const estimate = Math.floor((maxRows * (HTML_SIZE_LIMIT - LAYOUT_BYTES)) / Math.max(1, size - LAYOUT_BYTES));
    maxRows = Math.max(MIN_ROWS, Math.min(maxRows - 1, estimate));
    current = {
      ...report,
      warnings: [...report.warnings, `To stay under the email size limit, each section lists at most ${maxRows} rows.`],
    };
  }
}
