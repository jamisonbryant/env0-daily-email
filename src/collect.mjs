// Reads env0 data through the env0 CLI (2.x). Read-only: this module only ever runs
// `environment list`, `project list`, `deployment get`, and `template get`.
//
// Commands are spawned with argument arrays, never through a shell. Error output is
// reduced to the CLI's error type and message; environment variables are never logged.

import { spawn } from 'node:child_process';
import { isActiveEnvironment, normalizeRevision } from './classify.mjs';

/** A non-zero exit from the env0 CLI. `exitCode` follows the CLI's documented codes. */
export class Env0Error extends Error {
  constructor(exitCode, type, message) {
    super(message);
    this.name = 'Env0Error';
    this.exitCode = exitCode;
    this.type = type;
  }

  get isAuth() {
    return this.exitCode === 3 || this.type === 'auth';
  }

  get isTransient() {
    return this.exitCode === 75 || this.type === 'transient';
  }
}

/** The data could not be collected completely (e.g. a truncated list). */
export class IncompleteDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IncompleteDataError';
  }
}

const READ_ONLY_COMMANDS = new Set(['environment list', 'project list', 'deployment get', 'template get']);

function parseEnvelope(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function oneLine(text, max = 300) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Runs one env0 CLI command and returns the parsed envelope ({apiVersion, data, page?}).
 * @param {string[]} args
 * @param {{bin?: string, timeoutMs?: number}} [options]
 */
export function runEnv0(args, { bin = process.env.ENV0_BIN || 'env0', timeoutMs = 120_000 } = {}) {
  const command = args.slice(0, 2).join(' ');
  if (!READ_ONLY_COMMANDS.has(command)) {
    return Promise.reject(new Error(`Refusing to run env0 command "${command}": not on the read-only allowlist`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ENV0_CLIENT: 'env0-daily-email' } });
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? `env0 CLI not found (looked for "${bin}" on PATH)` : `could not start env0 CLI: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Env0Error(75, 'transient', `env0 ${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
        return;
      }
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) {
        const error = parseEnvelope(stderr)?.error;
        const message = error?.message ? oneLine(error.message) : oneLine(stderr) || 'no error message';
        reject(new Env0Error(code, error?.type ?? 'unknown', `env0 ${command} failed (exit ${code}, ${error?.type ?? 'unknown'}): ${message}`));
        return;
      }
      const envelope = parseEnvelope(stdout);
      if (!envelope || !('data' in envelope)) {
        reject(new Error(`env0 ${command} returned output that is not a JSON envelope`));
        return;
      }
      resolve(envelope);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a command, retrying once if the CLI reports a transient failure. */
async function runWithRetry(args, options) {
  try {
    return await runEnv0(args, options);
  } catch (e) {
    if (e instanceof Env0Error && e.isTransient) {
      await sleep(options?.retryDelayMs ?? 2000);
      return runEnv0(args, options);
    }
    throw e;
  }
}

/** Maps over items with at most `limit` calls in flight. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Collects everything the report needs into a snapshot (see classify.mjs).
 * Throws Env0Error for CLI failures on the environment list, and IncompleteDataError
 * if the list is truncated. Per-environment lookups that fail are recorded in
 * `failures` instead of aborting the run.
 */
export async function collectSnapshot({ organizationId, concurrency = 5, run = runWithRetry } = {}) {
  if (!organizationId) throw new Error('ENV0_ORGANIZATION_ID is not set');

  const list = await run(['environment', 'list', '--all', '-o', 'compact', '--organization', organizationId]);
  if (list.page?.truncated === true) {
    throw new IncompleteDataError('env0 environment list was truncated (page.truncated is true); refusing to report on partial data');
  }
  if (!Array.isArray(list.data)) throw new IncompleteDataError('env0 environment list returned no data array');
  const environments = list.data;

  let projects = null;
  try {
    const res = await run(['project', 'list', '--organization', organizationId, '-o', 'compact']);
    projects = Array.isArray(res.data) ? res.data : null;
  } catch {
    projects = null; // classify() reports this as a warning and falls back to IDs.
  }

  const failures = { deployments: {}, templates: {} };

  const deploymentIds = [
    ...new Set(environments.filter(isActiveEnvironment).map((e) => e.latestDeployment?.id).filter(Boolean)),
  ];
  const deployments = {};
  await mapLimit(deploymentIds, concurrency, async (id) => {
    try {
      deployments[id] = (await run(['deployment', 'get', id, '-o', 'compact'])).data;
    } catch (e) {
      failures.deployments[id] = e.message;
    }
  });

  // Templates are only needed where a deployment has no revision of its own.
  const templateIds = [
    ...new Set(
      Object.values(deployments)
        .filter((d) => d && !normalizeRevision(d.blueprintRevision) && d.blueprintId)
        .map((d) => d.blueprintId),
    ),
  ];
  const templates = {};
  await mapLimit(templateIds, concurrency, async (id) => {
    try {
      templates[id] = (await run(['template', 'get', id, '-o', 'compact'])).data;
    } catch (e) {
      failures.templates[id] = e.message;
    }
  });

  return { environments, projects, deployments, templates, failures };
}
