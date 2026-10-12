// Builds a large synthetic snapshot (default 300 active environments) where every
// section overflows the row cap, with long names, to test the HTML size limit.
const LONG = 'regional-service-cluster-with-a-long-name';

export function buildLargeSnapshot(count = 300, now = new Date('2026-03-10T14:00:00.000Z')) {
  const environments = [];
  const deployments = {};
  const templates = {
    'tpl-none': { id: 'tpl-none', name: 'single-use', type: 'terraform', repository: 'https://git.example.com/acme-infra/very-long-repository-name-for-size-testing.git' },
  };
  const projects = Array.from({ length: 8 }, (_, i) => ({ id: `proj-${i}`, name: `Project number ${i} with a longer name` }));
  for (let i = 0; i < count; i++) {
    const n = String(i).padStart(4, '0');
    const bucket = i % 3; // 0: waiting + off-branch, 1: off-branch, 2: no deployment record (could not be checked)
    environments.push({
      id: `env-${n}`,
      name: `${LONG}-${n}/prod/region-a/component`,
      projectId: `proj-${i % 8}`,
      status: bucket === 0 ? 'WAITING_FOR_USER' : 'ACTIVE',
      latestDeployment: bucket === 2 ? null : { id: `dep-${n}`, status: bucket === 0 ? 'WAITING_FOR_USER' : 'SUCCESS' },
      isArchived: false,
    });
    if (bucket === 2) continue;
    deployments[`dep-${n}`] = {
      id: `dep-${n}`,
      environmentId: `env-${n}`,
      status: bucket === 0 ? 'WAITING_FOR_USER' : 'SUCCESS',
      type: i % 6 === 0 ? 'destroy' : 'deploy',
      blueprintId: 'tpl-none',
      blueprintRevision: `feature/a-fairly-long-branch-name-for-testing-${n}`,
      startedBy: 'someone.with.a.long.address@example.com',
      createdAt: new Date(now - (i + 1) * 3_600_000).toISOString(),
      finishedAt: new Date(now - (i + 1) * 3_600_000 + 120_000).toISOString(),
    };
  }
  return { environments, projects, deployments, templates, failures: { deployments: {}, templates: {} } };
}
