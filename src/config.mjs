// Reads configuration from environment variables. Values are validated but never printed.

import { assertTimeZone } from './format.mjs';

export const DEFAULTS = Object.freeze({
  trackedBranch: 'main',
  timeZone: 'UTC',
  title: 'env0 daily status',
  maxRows: 50,
});

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * @param {Record<string, string|undefined>} env usually process.env
 * @param {{requireOrganization?: boolean}} [options]
 */
export function loadConfig(env, { requireOrganization = true } = {}) {
  const organizationId = nonEmpty(env.ENV0_ORGANIZATION_ID);
  if (requireOrganization && !organizationId) throw new ConfigError('ENV0_ORGANIZATION_ID is not set');

  const timeZone = nonEmpty(env.REPORT_TIMEZONE) ?? DEFAULTS.timeZone;
  try {
    assertTimeZone(timeZone);
  } catch {
    throw new ConfigError('REPORT_TIMEZONE is not a valid IANA time zone');
  }

  let maxRows = DEFAULTS.maxRows;
  if (nonEmpty(env.REPORT_MAX_ROWS)) {
    maxRows = Number(env.REPORT_MAX_ROWS);
    if (!Number.isInteger(maxRows) || maxRows < 1) throw new ConfigError('REPORT_MAX_ROWS must be a positive integer');
  }

  let appUrl = nonEmpty(env.ENV0_APP_URL);
  if (appUrl) {
    let parsed;
    try {
      parsed = new URL(appUrl);
    } catch {
      throw new ConfigError('ENV0_APP_URL is not a valid URL');
    }
    if (parsed.protocol !== 'https:') throw new ConfigError('ENV0_APP_URL must use https');
    appUrl = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  }

  return {
    organizationId,
    trackedBranch: nonEmpty(env.REPORT_TRACKED_BRANCH) ?? DEFAULTS.trackedBranch,
    timeZone,
    title: nonEmpty(env.REPORT_TITLE) ?? DEFAULTS.title,
    maxRows,
    appUrl,
  };
}
