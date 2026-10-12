# env0-daily-email

Builds a daily HTML status email about the environments in an [env0](https://www.env0.com) organization. It answers two questions:

1. **Which deployments are waiting for approval?**
2. **Which environments are not tracking the expected branch** (`main` by default)?

The tool only reads data, through the env0 CLI, and writes three files: `out/email.html`, `out/email.txt` and `out/summary.json`. Sending the email is left to whatever runs the tool. In the intended setup that is a scheduled Claude Code routine that follows [`CLAUDE.md`](CLAUDE.md) and sends through a Gmail connector.

## What the email contains

Sections appear in this order. Each one is always present; when it has nothing to report it shows a one-line all-clear message, so the reader knows the check ran.

| Section | An environment is listed when | Shows |
|---|---|---|
| **Waiting for approval** | Its latest deployment has status `WAITING_FOR_USER` | Environment, project, action (Deploy / Destroy), time waiting, who requested it. Oldest first. A pending destroy is labeled **Destroy**. Waits over 24 hours are highlighted in bold amber, and the duration text (`2d 4h`) shows it too |
| **Not tracking `<branch>`** | Its revision is set and is not exactly the tracked branch, or it has no revision of its own and inherits a different one from its template | Environment, project, last deployed date, revision, and kind: `Commit` for 7–40 lowercase hex characters, otherwise `Branch or tag`, with `(inherited)` when the revision comes from the template. Sorted by project, then environment |
| **No revision set** | Neither the environment nor its template sets a revision, so it follows the repository's default branch, which the report can't check. Also listed: environments with no readable deployment record | Environment, project, repository path (no host) |

Above the sections are a preheader, the title and date, and three summary figures. The footer gives the generation time and time zone, the source, scope notes, any warnings, and "This is an automated report."

Summary counts are always true totals. Each section lists at most `REPORT_MAX_ROWS` rows and then says "And N more not shown." Gmail clips messages at about 102 KB, so if the compiled HTML would go over **90,000 bytes** the per-section cap is lowered until it fits, and the footer says so. With every section full of long names and links (the 300-environment test fixture), about 30 rows per section fit.

Subject line examples:

- `env0 daily status: 2 awaiting approval · 3 off main` (parts that are zero are left out)
- `env0 daily status: all clear`

The subject only counts the first two sections. Environments with no revision set are informational and appear only in the body.

## Requirements

- Node.js 22 or later
- The **env0 CLI 2.x** (`env0`, the Go-based CLI; `npm install -g @env0/cli@2`). Version 1.x, the legacy deploy-only tool, will not work.
- `mjml` 5.4.1, installed globally or through `npm ci` (it is the only dependency)
- An env0 API key with read access to the organization. The tool never runs a mutating command (see [Safety](#safety)).

## Configuration

All values that differ between deployments come from environment variables. None are stored in this repository.

| Variable | Default | Purpose |
|---|---|---|
| `ENV0_ORGANIZATION_ID` | required | Organization to report on |
| `ENV0_API_KEY_ID`, `ENV0_API_KEY_SECRET` | required by the CLI | env0 API key (read by the env0 CLI, never by this tool) |
| `REPORT_TRACKED_BRANCH` | `main` | Branch environments are expected to track |
| `REPORT_TIMEZONE` | `UTC` | IANA time zone for every displayed time |
| `REPORT_TITLE` | `env0 daily status` | Heading and subject prefix |
| `REPORT_MAX_ROWS` | `50` | Per-section row cap (may be lowered automatically to respect the size limit) |
| `ENV0_APP_URL` | unset | Base URL of the env0 web app, e.g. `https://app.env0.com`. If set, environment names become links; if unset, no links are rendered |

Optional: `ENV0_BIN` and `MJML_BIN` override the paths of the two CLIs.

### Links

When `ENV0_APP_URL` is set, links follow the pattern in env0's documented webhook payload example:

- environment: `<ENV0_APP_URL>/p/<projectId>/environments/<environmentId>`
- deployment: `<ENV0_APP_URL>/p/<projectId>/environments/<environmentId>/deployments/<deploymentId>`

Waiting rows link to the waiting deployment. Rows in the other sections link to the environment. The pattern is not part of a formal API contract, so if env0 changes it, unset `ENV0_APP_URL` to turn links off.

## Running

```sh
npm ci --omit=dev        # only needed if mjml is not installed globally
node src/main.mjs        # or: npm run build
```

| Exit code | Meaning |
|---|---|
| `0` | Report built |
| `2` | env0 authentication failure |
| `3` | Data incomplete: the environment list was truncated, or more than 10% of per-environment lookups failed |
| `1` | Anything else (configuration error, CLI missing, compile failure, …) |

On failure, a single line with the reason goes to stderr. The tool never prints environment variables or request headers.

`out/summary.json`:

```json
{
  "subject": "env0 daily status: 2 awaiting approval · 3 off main",
  "counts": { "waiting": 2, "offBranch": 3, "unknownRevision": 1, "totalActive": 40 },
  "generatedAt": "2026-03-10T14:00:00.000Z",
  "warnings": []
}
```

`warnings` lists non-fatal problems, such as project names being unavailable or a few lookups failing. The same text appears in the email footer.

### Preview and tests

```sh
npm run preview   # renders out/preview.html and out/preview.txt from test/fixtures/snapshot.json, without calling env0
npm test          # node:test unit tests
```

The fixtures are synthetic. `test/fixtures/build-snapshot.mjs` regenerates `snapshot.json`, and `test/fixtures/large.mjs` builds the 300-environment fixture used for the size test.

## How the data is collected

The tool makes these read-only CLI calls. Each call is spawned with an argument array, never through a shell.

1. `env0 environment list --all -o compact --organization <id>`: one call. The tool stops with exit 3 if `page.truncated` is true.
2. `env0 project list --organization <id>`: one call, to resolve project names and parent projects. If it fails, project IDs are shown and a warning is added.
3. `env0 deployment get <latestDeployment.id>`: one call per active environment, five at a time, with one retry on a transient error.
4. `env0 template get <templateId>`: only for deployments that have no revision of their own, again five at a time.

An organization with about 170 active environments takes roughly 20–25 seconds.

**Active** means `isArchived` is false and `status` is not `INACTIVE`. `environment list` does not return workflow sub-environments, so they are not covered. The email footer states this.

### Field mapping

This section describes the env0 CLI 2.x output that the report depends on, using a synthetic example. The CLI wraps every response in `{ "apiVersion": "0.1", "data": ... }`. List commands also return `"page": { "truncated": false }`.

`environment list` entry:

```json
{
  "id": "env-0001",
  "name": "payments-api-prod",
  "projectId": "proj-0001",
  "status": "WAITING_FOR_USER",
  "isArchived": false,
  "latestDeployment": { "id": "dep-0001", "status": "WAITING_FOR_USER" }
}
```

`deployment get dep-0001`:

```json
{
  "id": "dep-0001",
  "environmentId": "env-0001",
  "status": "WAITING_FOR_USER",
  "type": "deploy",
  "blueprintId": "tpl-0001",
  "blueprintRevision": "main",
  "startedBy": "env0-system",
  "createdAt": "2026-03-08T10:00:00.000Z",
  "finishedAt": "2026-03-08T10:03:00.000Z"
}
```

`template get tpl-0001`:

```json
{ "id": "tpl-0001", "repository": "https://git.example.com/acme-infra/network.git", "revision": "main" }
```

`project list` entry:

```json
{ "id": "proj-0001", "name": "region-a", "parentProjectId": "proj-0000" }
```

| Report field | Source | Notes |
|---|---|---|
| Active | `environment.isArchived`, `environment.status` | Excluded when archived or `INACTIVE` |
| Latest deployment | `environment.latestDeployment.id` → `deployment get` | Use this pointer, not the first row of `deployment list`: that list also contains PR-plan runs, which don't change the environment |
| Waiting for approval | `deployment.status == "WAITING_FOR_USER"` | Falls back to `environment.latestDeployment.status` if the deployment can't be read |
| Action | `deployment.type` | `deploy` or `destroy` |
| Waiting since | `deployment.createdAt` | When the deployment was requested. `finishedAt` on a waiting deployment marks the end of its plan step |
| Requested by | `deployment.startedBy` | A single string: `env0-system` (shown as "Automatic (env0)"), an email (shown as is), or an opaque identity-provider user ID (shown as "Unknown", because the CLI exposes no name or email for it) |
| Configured revision | `deployment.blueprintRevision` of the latest deployment | env0 keeps an environment's revision on its latest deployment. The key is **omitted** when unset; `null` and `""` are treated the same way |
| Template default revision | `template.revision` | Also omitted when unset. Used only when the environment has no revision of its own |
| Repository | `template.repository` | Shown as a path, without host or `.git` |
| Project | `project.name`, walking `parentProjectId` | Shown as `parent / child`, because sub-project names often repeat under different parents |
| Last deployed | `deployment.finishedAt`, else `createdAt` | "Never" when the status is `NEVER_DEPLOYED` |

## Limitations

- **Requester names.** For deployments started by a person, the CLI returns only an opaque user ID, so the report shows "Unknown". Automated deployments show "Automatic (env0)".
- **Environments with no deployment record.** Some environments have `latestDeployment: null` in `environment list`. For these, `deployment list` and `context` can also fail in CLI 2.6.0 with a decode error (`costEstimation.totalMonthlyCost` sometimes arrives as a string). The report lists them under **No revision set** as "No deployment record" instead of skipping them.
- **Repository default branches.** The report cannot see a repository's default branch, so environments that follow it are listed under **No revision set** rather than assumed to be on `main`.
- **Workflow sub-environments** are not included (see above).
- **Branch or tag.** A non-SHA revision is labeled "Branch or tag" because the data does not say which it is.

## Safety

- The tool runs only an allowlist of read commands (`environment list`, `project list`, `deployment get`, `template get`) and refuses anything else, even if the API key could do more.
- It never reads, prints or logs credentials or environment variables.
- Every string from the API is HTML-escaped before it goes into markup. The email loads no external fonts, images or scripts.

## Layout

```
src/collect.mjs    env0 CLI calls (spawned without a shell), envelope parsing, exit codes
src/classify.mjs   pure classification into the three sections
src/render.mjs     MJML generation, compile (strict validation), size guard, plain text
src/format.mjs     escaping, durations, dates, repository paths
src/config.mjs     environment variable parsing and validation
src/main.mjs       orchestration and exit codes
src/preview.mjs    renders the fixture preview
templates/         report.mjml and section.mjml
test/              node:test suites and synthetic fixtures
```

## License

MIT
