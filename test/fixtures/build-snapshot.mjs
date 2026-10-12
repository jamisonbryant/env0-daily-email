// Generates test/fixtures/snapshot.json. All names, IDs, and hosts are synthetic.
// Run: node test/fixtures/build-snapshot.mjs
import { writeFileSync } from 'node:fs';

const env = (n, name, projectId, status, latest, extra = {}) => ({
  id: `env-${n}`,
  name,
  projectId,
  organizationId: 'org-example',
  status,
  driftStatus: 'DISABLED',
  workspaceName: 'default',
  latestDeployment: latest === null ? null : { id: `dep-${n}`, status: latest },
  isArchived: false,
  isLocked: false,
  requiresApproval: true,
  createdAt: '2026-01-05T15:00:00.000Z',
  updatedAt: '2026-03-01T15:00:00.000Z',
  tags: {},
  ...extra,
});

const dep = (n, status, fields = {}) => ({
  id: `dep-${n}`,
  environmentId: `env-${n}`,
  status,
  type: 'deploy',
  blueprintId: 'tpl-shared',
  blueprintRevision: 'main',
  startedBy: 'env0-system',
  createdAt: '2026-03-02T16:00:00.000Z',
  finishedAt: '2026-03-02T16:04:00.000Z',
  ...fields,
});

const environments = [
  env('01', 'payments-api-prod', 'proj-payments', 'WAITING_FOR_USER', 'WAITING_FOR_USER'),
  env('02', 'network-shared', 'proj-platform', 'WAITING_FOR_USER', 'WAITING_FOR_USER'),
  env('03', 'search-indexer-staging', 'proj-data', 'WAITING_FOR_USER', 'WAITING_FOR_USER'),
  env('04', 'billing-worker-prod', 'proj-payments', 'ACTIVE', 'SUCCESS'),
  env('05', 'analytics-etl-dev', 'proj-data', 'ACTIVE', 'SUCCESS'),
  env('06', 'edge-cache-prod', 'proj-platform', 'ACTIVE', 'SUCCESS'),
  env('07', 'reporting-db-prod', 'proj-data', 'FAILED', 'FAILURE'),
  env('08', 'identity-api-staging', 'proj-platform', 'ACTIVE', 'SUCCESS'),
  env('09', 'queue-workers-dev', 'proj-platform', 'ACTIVE', 'SUCCESS'),
  env('10', 'docs-site-preview', 'proj-platform', 'ACTIVE', 'SUCCESS'),
  env('11', 'legacy-vpn', 'proj-platform', 'ACTIVE', null),
  env('12', 'old-batch-jobs', 'proj-data', 'WAITING_FOR_USER', 'WAITING_FOR_USER', { isArchived: true }),
  env('13', 'retired-gateway', 'proj-platform', 'INACTIVE', 'SUCCESS'),
  env('14', 'orphan-service-dev', 'proj-unlisted', 'ACTIVE', 'SUCCESS'),
  env('15', '<script>alert(1)</script>-prod', 'proj-payments', 'ACTIVE', 'SUCCESS'),
  env('16', 'sandbox-bootstrap', 'proj-data', 'NEVER_DEPLOYED', 'NEVER_DEPLOYED'),
  env('17', 'metrics-collector-prod', 'proj-platform', 'ACTIVE', 'SUCCESS'),
  env('18', 'mail-relay-prod', 'proj-payments', 'ACTIVE', 'SUCCESS'),
  env('19', 'ledger-archive-prod', 'proj-payments', 'ACTIVE', 'SUCCESS'),
  // Same environment name in two sub-projects that share a name under different parents.
  env('20', 'shared/secrets', 'proj-prod-region-a', 'ACTIVE', 'SUCCESS'),
  env('21', 'shared/secrets', 'proj-stage-region-a', 'ACTIVE', 'SUCCESS'),
];

const deployments = {
  // A: deploy waiting over 24h, started by automation.
  'dep-01': dep('01', 'WAITING_FOR_USER', { createdAt: '2026-03-08T10:00:00.000Z', finishedAt: '2026-03-08T10:03:00.000Z' }),
  // A: destroy waiting a few hours, started by an email-identified user.
  'dep-02': dep('02', 'WAITING_FOR_USER', { type: 'destroy', startedBy: 'operator@example.com', createdAt: '2026-03-10T10:48:00.000Z' }),
  // A: waiting under a minute, opaque user ID; also off-branch (B).
  'dep-03': dep('03', 'WAITING_FOR_USER', { blueprintRevision: 'feature/new-index', startedBy: 'idp|000000000000', createdAt: '2026-03-10T13:59:30.000Z' }),
  // Tracks main: no section.
  'dep-04': dep('04', 'SUCCESS'),
  // B: tag-like string.
  'dep-05': dep('05', 'SUCCESS', { blueprintRevision: 'v2.14.0' }),
  // B: short SHA.
  'dep-06': dep('06', 'SUCCESS', { blueprintRevision: 'a1b2c3d' }),
  // B: full SHA, failed deployment.
  'dep-07': dep('07', 'FAILURE', { blueprintRevision: '0123456789abcdef0123456789abcdef01234567' }),
  // Missing revision; template default is main: no section.
  'dep-08': (({ blueprintRevision, ...rest }) => ({ ...rest, blueprintId: 'tpl-main' }))(dep('08', 'SUCCESS')),
  // Null revision; template default differs: B (inherited).
  'dep-09': dep('09', 'SUCCESS', { blueprintRevision: null, blueprintId: 'tpl-develop' }),
  // Empty revision; template has no default: assumed repository default (main), no section.
  'dep-10': dep('10', 'SUCCESS', { blueprintRevision: '', blueprintId: 'tpl-single-use' }),
  'dep-12': dep('12', 'WAITING_FOR_USER'),
  'dep-13': dep('13', 'SUCCESS', { blueprintRevision: 'feature/retired' }),
  // Project not in project list; different branch.
  'dep-14': dep('14', 'SUCCESS', { blueprintRevision: 'develop' }),
  // Hostile strings in names and revisions.
  'dep-15': dep('15', 'SUCCESS', { blueprintRevision: '<img src=x onerror=alert(1)>' }),
  // Never deployed, on a feature branch.
  'dep-16': dep('16', 'NEVER_DEPLOYED', { blueprintRevision: 'feature/bootstrap', finishedAt: undefined }),
  // Missing revision; template lookup failed: C.
  'dep-17': (({ blueprintRevision, ...rest }) => ({ ...rest, blueprintId: 'tpl-unreadable' }))(dep('17', 'SUCCESS')),
  // Long branch name, to exercise wrapping and truncation.
  'dep-19': dep('19', 'SUCCESS', { blueprintRevision: 'feature/ledger-archive-retention-policy-and-cold-storage-tiering' }),
  'dep-20': dep('20', 'SUCCESS', { blueprintRevision: 'release/2026.03' }),
  'dep-21': dep('21', 'SUCCESS', { blueprintRevision: 'release/2026.03' }),
  // dep-18 lookup failed (see failures).
};
delete deployments['dep-16'].finishedAt;

const templates = {
  'tpl-main': { id: 'tpl-main', name: 'shared-stack', type: 'terraform', repository: 'https://git.example.com/acme-infra/shared.git', revision: 'main' },
  'tpl-develop': { id: 'tpl-develop', name: 'dev-stack', type: 'terraform', repository: 'https://git.example.com/acme-infra/dev.git', revision: 'develop' },
  'tpl-single-use': { id: 'tpl-single-use', name: 'single-use', type: 'terragrunt', repository: 'https://git.example.com/acme-infra/network.git' },
};

const projects = [
  { id: 'proj-payments', name: 'Payments', isArchived: false },
  { id: 'proj-platform', name: 'Platform', isArchived: false },
  { id: 'proj-data', name: 'Data', isArchived: false },
  { id: 'proj-prod', name: 'Production', isArchived: false },
  { id: 'proj-stage', name: 'Staging', isArchived: false },
  { id: 'proj-prod-region-a', name: 'region-a', parentProjectId: 'proj-prod', isArchived: false },
  { id: 'proj-stage-region-a', name: 'region-a', parentProjectId: 'proj-stage', isArchived: false },
];

const snapshot = {
  environments,
  projects,
  deployments,
  templates,
  failures: {
    deployments: { 'dep-18': 'env0 deployment get failed (exit 1, unknown): synthetic failure' },
    templates: { 'tpl-unreadable': 'env0 template get failed (exit 4, not_found): synthetic failure' },
  },
};

const out = new URL('./snapshot.json', import.meta.url);
writeFileSync(out, `${JSON.stringify({ now: '2026-03-10T14:00:00.000Z', snapshot }, null, 2)}\n`);
console.log(`wrote ${out.pathname}`);
