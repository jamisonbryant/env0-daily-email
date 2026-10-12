// Turns a snapshot of env0 data into the report's three sections.
// Pure functions only: no I/O, no clock (the caller passes `now`).
//
// A snapshot is what collect.mjs gathers, in the shapes the env0 CLI returns:
// {
//   environments: [...],          // `environment list` data
//   projects: [...] | null,       // `project list` data, or null if unavailable
//   deployments: { [id]: {...} }, // `deployment get` data, keyed by deployment id
//   templates: { [id]: {...} },   // `template get` data, keyed by template id
//   failures: { deployments: { [id]: reason }, templates: { [id]: reason } }
// }

export const WAITING_STATUS = 'WAITING_FOR_USER';
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;
const AUTOMATION_USER = 'env0-system';

/** Active means not archived and not inactive. */
export function isActiveEnvironment(env) {
  return Boolean(env) && env.isArchived !== true && env.status !== 'INACTIVE';
}

/** A revision counts as set only when it is a non-empty string. Missing, null, and "" are all unset. */
export function normalizeRevision(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function revisionKind(revision, inherited = false) {
  const base = COMMIT_SHA.test(revision) ? 'Commit' : 'Branch or tag';
  return inherited ? `${base} (inherited)` : base;
}

/** Best available description of who started a deployment. */
export function requesterLabel(startedBy) {
  if (startedBy && typeof startedBy === 'object') {
    const name = typeof startedBy.name === 'string' ? startedBy.name.trim() : '';
    const email = typeof startedBy.email === 'string' ? startedBy.email.trim() : '';
    return name || email || 'Unknown';
  }
  if (typeof startedBy === 'string') {
    const s = startedBy.trim();
    if (s === AUTOMATION_USER) return 'Automatic (env0)';
    if (/^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(s)) return s;
  }
  // Opaque identity-provider IDs carry no name or email.
  return 'Unknown';
}

export function actionLabel(type) {
  if (type === 'deploy') return 'Deploy';
  if (type === 'destroy') return 'Destroy';
  if (typeof type === 'string' && type) return type.charAt(0).toUpperCase() + type.slice(1);
  return 'Unknown';
}

/**
 * Maps project IDs to display paths such as "Production / region-a". Sub-projects often
 * share names across parents, so the bare name alone can be ambiguous.
 */
export function projectPaths(projects) {
  const byId = new Map(projects.filter((p) => p && p.id).map((p) => [p.id, p]));
  const paths = new Map();
  for (const project of byId.values()) {
    const names = [];
    const seen = new Set();
    for (let p = project; p && !seen.has(p.id); p = byId.get(p.parentProjectId)) {
      seen.add(p.id);
      names.unshift(typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.id);
    }
    paths.set(project.id, names.join(' / '));
  }
  return paths;
}

function countEnvironments(n) {
  return n === 1 ? '1 environment, which is' : `${n} environments, which are`;
}

function byProjectThenName(a, b) {
  return (
    a.projectName.localeCompare(b.projectName, 'en', { sensitivity: 'base' }) ||
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Classifies a snapshot.
 * @param {object} snapshot see top of file
 * @param {{trackedBranch: string}} config
 * @param {Date} now
 */
export function classify(snapshot, config, now) {
  const trackedBranch = config.trackedBranch;
  const warnings = [];
  let projectNames = new Map();
  if (Array.isArray(snapshot.projects)) {
    projectNames = projectPaths(snapshot.projects);
  } else {
    warnings.push('Project names could not be loaded; project IDs are shown instead.');
  }

  const deployments = snapshot.deployments ?? {};
  const templates = snapshot.templates ?? {};
  const failedDeployments = snapshot.failures?.deployments ?? {};
  const failedTemplates = snapshot.failures?.templates ?? {};

  const active = (snapshot.environments ?? []).filter(isActiveEnvironment);
  const waiting = [];
  const offBranch = [];
  const unknownRevision = [];
  let deploymentLookupFailures = 0;
  let templateLookupFailures = 0;

  for (const env of active) {
    const base = {
      id: env.id,
      name: env.name || env.id,
      projectId: env.projectId ?? null,
      projectName: projectNames.get(env.projectId) ?? env.projectId ?? 'Unknown project',
    };
    const latestId = env.latestDeployment?.id ?? null;
    const deployment = latestId ? deployments[latestId] : null;
    const latestStatus = deployment?.status ?? env.latestDeployment?.status ?? null;

    if (latestId && !deployment && failedDeployments[latestId]) deploymentLookupFailures += 1;

    // Section A: latest deployment is paused for approval.
    if (latestStatus === WAITING_STATUS) {
      const requestedAt = deployment?.createdAt ? new Date(deployment.createdAt) : null;
      const waitedMs = requestedAt && !Number.isNaN(requestedAt.getTime()) ? Math.max(0, now - requestedAt) : null;
      waiting.push({
        ...base,
        deploymentId: latestId,
        action: actionLabel(deployment?.type),
        isDestroy: deployment?.type === 'destroy',
        requestedAt: requestedAt ? requestedAt.toISOString() : null,
        waitedMs,
        requestedBy: requesterLabel(deployment?.startedBy),
      });
    }

    // Sections B and C: which revision does this environment follow?
    if (!deployment) {
      unknownRevision.push({
        ...base,
        repository: null,
        reason: latestId ? 'unreadable' : 'no-deployment',
      });
      continue;
    }

    const ownRevision = normalizeRevision(deployment.blueprintRevision);
    const lastDeployedAt =
      deployment.status === 'NEVER_DEPLOYED' ? null : deployment.finishedAt || deployment.createdAt || null;

    if (ownRevision) {
      if (ownRevision !== trackedBranch) {
        offBranch.push({ ...base, revision: ownRevision, kind: revisionKind(ownRevision), inherited: false, lastDeployedAt });
      }
      continue;
    }

    const templateId = deployment.blueprintId ?? null;
    const template = templateId ? templates[templateId] : null;
    if (templateId && !template && failedTemplates[templateId]) templateLookupFailures += 1;
    const inherited = normalizeRevision(template?.revision);
    if (inherited) {
      if (inherited !== trackedBranch) {
        offBranch.push({ ...base, revision: inherited, kind: revisionKind(inherited, true), inherited: true, lastDeployedAt });
      }
      continue;
    }

    unknownRevision.push({
      ...base,
      repository: typeof template?.repository === 'string' ? template.repository : null,
      reason: template ? 'repository-default' : 'unreadable',
    });
  }

  if (deploymentLookupFailures) {
    warnings.push(`The latest deployment could not be read for ${countEnvironments(deploymentLookupFailures)} listed under No revision set.`);
  }
  if (templateLookupFailures) {
    warnings.push(`Template details could not be read for ${countEnvironments(templateLookupFailures)} listed under No revision set.`);
  }

  waiting.sort((a, b) => (b.waitedMs ?? -1) - (a.waitedMs ?? -1) || a.name.localeCompare(b.name));
  offBranch.sort(byProjectThenName);
  unknownRevision.sort(byProjectThenName);

  return {
    trackedBranch,
    waiting,
    offBranch,
    unknownRevision,
    counts: {
      waiting: waiting.length,
      offBranch: offBranch.length,
      unknownRevision: unknownRevision.length,
      totalActive: active.length,
    },
    lookupFailures: { deployments: deploymentLookupFailures, templates: templateLookupFailures },
    warnings,
  };
}

/** Email subject: "<title>: 2 awaiting approval · 3 off main", or "<title>: all clear". */
export function buildSubject(title, counts, trackedBranch) {
  const parts = [];
  if (counts.waiting) parts.push(`${counts.waiting} awaiting approval`);
  if (counts.offBranch) parts.push(`${counts.offBranch} off ${trackedBranch}`);
  return `${title}: ${parts.length ? parts.join(' · ') : 'all clear'}`;
}
