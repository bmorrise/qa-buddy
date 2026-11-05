# QA Buddy

QA Buddy is a local dashboard for running trusted GitHub repository test suites in disposable Docker containers and tracking coverage for every configured app. Single-app repositories and monorepos use the same model: a repository contains one or more explicit app configurations.

## Start QA Buddy

Requirements:

- Docker Desktop or Docker Engine with Compose.
- Port `3003` available on the host.

```bash
cp .env.example .env
docker compose up --build
```

Open [http://localhost:3003](http://localhost:3003). Configuration, run summaries, and logs persist in the `qa-buddy-data` Docker volume. Fresh checkouts use `qa-buddy-workspaces` and are removed after every run.

Compose bind-mounts the QA Buddy source and watches it inside each service. Changes under the server, worker, web, database, or shared source directories are rebuilt automatically and the affected service is restarted; refresh the browser to load an updated dashboard bundle. You only need `docker compose up --build -d --force-recreate` after changing dependencies, package manifests, the Dockerfile, Compose configuration, or the development watcher itself.

The `.env` file is optional for public repositories. For a private repository, create a fine-grained GitHub personal access token scoped only to the required repository, with **Contents: read-only**, and add it locally:

```dotenv
GITHUB_TOKEN=github_pat_your_token_here
```

Then apply it to the worker:

```bash
docker compose up -d --force-recreate worker
```

The Docker worker reads `GITHUB_TOKEN` from `.env`; a token exported in the shell running Compose does not override it. After changing or removing the token in `.env`, recreate the worker with the command above. Restarting an existing container does not reload its environment. Startup and run logs show the first 10 token characters followed by `********` so you can identify the configured token; tokens of 10 characters or fewer are fully redacted. QA Buddy passes the token to Git through a non-interactive askpass helper; the full token is not stored in SQLite, embedded in repository URLs, sent to runner containers, or written to logs. If the organization requires approval or SSO authorization for tokens, complete that in GitHub before running the repository.

## Configure a repository

Repository configuration includes:

- A GitHub HTTPS URL and default branch, tag, or commit SHA.
- An optional local checkout path for running against your own working tree.
- A runner image that provides `/bin/sh` and the required language tools.
- An optional setup command that runs once at the repository root.
- An optional build-command override that runs once after setup and before any selected app tests.
- A per-app test-worker limit, defaulting to `2`, for auto-detected Jest and Vitest commands. Parallel Jest workers are recycled after 1 GiB so long suites cannot grow a worker until Node exhausts its heap; scripts already using `--runInBand` keep their intentional serial execution.
- An overall run timeout from 1 to 120 minutes. This is a safety cap; individual apps are held to their own limits (see [Time limits](#time-limits)).
- Optional environment variable names to pass from the worker to the runner.
- Automatic pnpm/Turborepo app detection, or one or more manually configured apps.

### Automatic pnpm/Turborepo detection

Enable **Auto-detect pnpm/Turborepo apps** when the repository has a root `pnpm-workspace.yaml`. On every fresh clone, QA Buddy:

1. Expands the workspace package globs without following symlinks outside the checkout.
2. Prioritizes workspaces under `apps/`; if there is no `apps/` group, it considers all workspaces.
3. Reads each workspace `package.json` and selects `test:coverage`, then `test:cov`, `coverage`, and finally `test` in that order.
4. Runs the selected script from that app's workspace directory.
5. Adds Jest or Vitest's JSON test reporter, requires an Istanbul-compatible JSON coverage summary for both runners, also asks for Istanbul's detailed `coverage-final.json` report (the source of per-file gap locations), and records exact passed, failed, skipped, and todo test cases.
6. Limits parallel Jest and Vitest workers to the configured per-app value, preserves serial Jest scripts, uses version-compatible Vitest worker flags, and ignores compiled `dist` output during Jest coverage collection.
7. Clears that app's old structured-test and coverage files before execution, then discovers newly generated `coverage/coverage-summary.json` or `coverage/lcov.info`, including repository-root `coverage/apps/...` layouts and both JSON/LCOV files in safe shared Jest `coverageDirectory` values from package.json. This prevents a failed app from inheriting another app's shared or stale report.

The presence of `turbo.json` is reported in the run log, but pnpm workspace configuration remains the source of truth for app directories. Workspaces without a supported test script are ignored. Detection fails with an actionable error when no testable apps are found.

### Testing shared libraries alongside apps

Only workspaces under `apps/` are detected automatically. Shared libraries such as `libs/scout-ui` are opt-in: list their directories in **Additional workspaces** on the repository form, comma separated. They are then detected exactly like an app, including script selection, coverage reporting, per-app selection, and their own coverage snapshot.

Inclusion is explicit rather than automatic so that adding a library to the repository never silently changes what a run tests. Two outcomes are deliberately different:

- A directory that is not a pnpm workspace fails the run with an actionable error. Asking for something that cannot run is a configuration mistake, and failing quietly would leave you wondering why it never appeared.
- A workspace whose test script is missing, or whose suite reports no tests at all (for example a package mid-migration running `--passWithNoTests`), is skipped without failing the run. Its applications are marked skipped and no coverage snapshot is written, so an empty suite never registers as 0% coverage.

### Excluding workspaces

List directories in **Excluded workspaces** on the repository form, comma separated, to keep auto-detection from testing them even when they have a test script, for example `apps/user-crm-sync` before it has a real suite. Exclusions apply to `apps/*` and to the fallback used when there is no `apps/` directory. A directory cannot be both additional and excluded. Newly excluded apps leave the selectable app list as soon as the configuration is saved.

Unlike additional workspaces, an exclusion that matches no workspace (an app since deleted from the repository, say) does not fail the run. The run log lists what was excluded and warns about entries it could not find, so stale exclusions are visible without blocking everything else.

The form suggests `corepack enable && pnpm install --frozen-lockfile` as the setup command and `pnpm build` as the build command when auto-detection is enabled. A build failure skips all app tests so tests never run against missing workspace artifacts. Adjust either command when the repository uses a different bootstrap or build entry point.

Example for a single Node app:

```text
Runner image:      node:22-bookworm
Setup command:     npm ci
App directory:     .
Test command:      npm test -- --coverage
Coverage format:   Istanbul summary JSON
Coverage path:     coverage/coverage-summary.json
```

For a pnpm monorepo that does not follow these conventions, leave auto-detection off and add one app entry per workspace with an explicit command and report path.

Supported coverage inputs:

- `coverage-summary.json` generated by Istanbul-compatible tools. Lines, statements, functions, and branches are shown.
- LCOV. Lines, functions, and branches are shown; statements are `N/A` because LCOV does not define a separate statement metric.

A run passes only when every app test exits successfully and every configured coverage report is present and valid. Coverage is still parsed after a failing test command when the report exists. Apps later in a monorepo continue after an earlier app fails.

From the repository detail page, a multi-app run can target any subset of the configured or most recently detected apps. Use **Select failed** to quickly rerun only applications that failed the latest run. The selected app names are retained with the run, and auto-detected selections are checked again after cloning the requested ref. Run all apps once before using per-app selection on a newly configured auto-detected repository.

### Filtering and saved groups

The application picker filters on both the package name and the working directory, so `libs/` narrows to shared libraries and `riverside` finds a family of apps whatever their scope prefix. While a filter is active, **Select all** applies only to the visible matches, and any selected application hidden by the filter is called out so nothing runs unseen. The picker shows the short package name; results views keep the full name so the owning repository stays clear.

Save a selection you use often with **Save selection as group**, name it, and apply it later in one click. Groups:

- Are explicit lists of application names, scoped to one repository, with unique names. They never update themselves, so a saved group keeps producing the same set of results as the repository grows.
- Replace the current selection when applied rather than adding to it.
- Select only applications that still exist. A group whose apps have been renamed or removed shows how many are no longer detected and applies the rest, so a stale entry cannot fail a run.
- Show an **Update** action once the current selection has drifted from the applied group, which re-points the group at what is selected now. Rename and delete are available on each group.

The app results table shows how long each application took, rounded to the nearest second, alongside a breakdown of the run total into app time and the checkout, setup, and build phases. This makes it obvious when a single workspace dominates a run.

The run detail page provides an expandable test-case readout for auto-detected Jest and Vitest apps. It records test names, source test files, durations, statuses, and bounded failure messages. For a manually configured command, QA Buddy will also consume a Jest-compatible JSON report written to `.qa-buddy-test-results.json` in the app working directory. Other test runners continue to use the full redacted log as their detailed readout.

## Run against a local working tree

By default every run fetches a fresh shallow clone from GitHub, so only pushed commits are visible. To test uncommitted work, point QA Buddy at your own checkout.

Set the directory that holds your repositories in `.env`:

```dotenv
QA_BUDDY_LOCAL_SOURCE_ROOT=/Users/you/Repositories
```

Then recreate the worker so it picks up the new mount:

```bash
docker compose up -d --force-recreate worker
```

You will need to edit/add the local name of this repo into the `Section 01` of the Configuration for the repo. You will not see the local run checkbox without this in the Config, and it will fail completely if you dont had the `QA_BUDDY_LOCAL_SOURCE_ROOT` in your env file

Compose bind-mounts that directory read-only at `/local-source`. Add the repository's subdirectory name to its **Local checkout path** field (for example `platform` for `/Users/you/Repositories/platform`), and a **Run against my local working tree** checkbox appears on the repository page. The saved default ref is still used for every ordinary run; the checkbox is a per-run choice and does not change it.

QA Buddy builds the checkout with `git archive HEAD`, then overlays modified and untracked files and removes deleted ones, so uncommitted work is included while the source checkout is never written to. Because the file set comes from Git:

- Gitignored files never reach the runner. That includes `.env`, `node_modules`, and build output. Host `node_modules` would be the wrong platform for a Linux runner anyway, so setup still installs dependencies inside the container.
- A file you have created but not yet `git add`ed is included, because untracked files that are not ignored are copied. Files excluded by `.gitignore` are not.
- Committed files are never removed, so a local run contains exactly what a run off the same commit would, plus your uncommitted changes. A committed `.env.test` or similar fixture still reaches the runner. Credential-shaped committed files are reported in the run log so you know they are there.
- An uncommitted `.env` style file that is not gitignored is skipped rather than copied, because a GitHub run would not have it either.

Runs against a local working tree record the `HEAD` commit and are marked dirty when uncommitted changes were applied, so they are never mistaken for a reproducible run. The run history shows `local working tree` in place of the ref and appends `+dirty` to the commit.

Local runs are for iterating before you push. Anything you intend to keep should still be pushed and run against its branch.

## Environment pass-through

Values belong in `.env`, not in the dashboard. Add only their names to a repository's environment allowlist. The worker reads those values and passes only the selected variables into that repository's runner. Values are redacted from logs.

`GITHUB_TOKEN` is reserved for cloning and is rejected from runner allowlists. Use a separate, narrowly scoped package token such as `NPM_TOKEN` when tests need private packages.

If a repository's `.npmrc` references a named variable, put that variable in `.env` and add only its name to the repository's environment allowlist. For example, ID Plans uses `GITHUB_IDP_REGISTRY`. The Docker worker reads this token from `.env`, ignoring shell overrides, and displays its first 10 characters followed by `********` in startup and run logs (short tokens are fully redacted). Recreate the worker after changing it. Run logs also indicate when the token is not allowlisted for that repository. GitHub's npm package registry currently requires a personal access token (classic) with at least `read:packages`; keep this package token separate from the repository clone token.

If `GITHUB_IDP_REGISTRY` is used, you will need to include it in the `Allowed environment variable names` field of #2 Runner section.

The Build command override may be required for some apps where the default cannot be completed. As an example, with sub-applications pdf/renderer that cannot build correctly, you can use this override: `pnpm exec turbo run build --concurrency=2 --filter=!pdf --filter=!renderer` to ommit them and have the tool build correctly.

## Stopping a run

**Stop run** is available on the repository page while a run is in flight, and on the run detail page. A stopped run finishes as `interrupted`, not `failed`, so a deliberate stop is never mistaken for a broken test suite. Applications that had not finished are marked skipped, and the repository is free to queue a new run immediately.

A run can be stopped in any phase, including a long setup or build. The worker checks for a stop after cloning, after setup, after the build, before each app, and after each test command, and killing the runner container interrupts whatever command is running rather than waiting for it to finish.

A run that has not been claimed by the worker yet stops instantly. A run already in flight is flagged, and the worker notices within about a second. The server and worker are separate processes sharing only SQLite, so the stop is polled rather than pushed.

While a run is active the repository page refreshes every two seconds; the run detail page streams updates continuously.

Stopped runs never update a coverage snapshot, since their apps did not finish.

## Time limits

Each app's test command gets its own time limit, so one slow or stuck app fails on its own instead of using up the run's time and leaving every later app skipped.

- **Per-app limit.** Three times the app's slowest passing duration across its last five passing runs in this repository, with a minimum of 10 minutes. An app with no passing history gets 30 minutes. The run log shows each app's limit and how it was derived, for example `Testing @idplans/idp-api-service (time limit 48 minutes: 3x its slowest recent pass of 16 minutes)`.
- **No-output timeout.** Any setup, build, or test command that prints nothing for 10 minutes is treated as hung. This catches, for example, a Jest process that finishes its tests but never exits.
- **Overall timeout.** The repository's run timeout still applies as a safety cap across the whole run.

When an app exceeds its limit or goes silent, QA Buddy kills that command and every worker it started, records the app as failed with the reason, and continues with the next app in the same runner. The run then finishes as `failed`, noting how many apps timed out. A hung setup or build cannot be skipped past, so it ends the run as `timed_out`, as does reaching the overall timeout.

## Coverage gaps

Every run that uses a GitHub ref records a per-file coverage snapshot for each app that produced a report. Open **Coverage gaps** from the repository page to rank files by their weakest metric.

Snapshots are deliberately not part of run history:

- One snapshot per app, replaced in place. Storing per-file coverage for every retained run would keep twenty near-identical copies of the same data.
- They survive run history pruning. The run that produced a snapshot can age out of the latest 20 without taking the snapshot with it; the recorded commit still says where it came from.
- **Local working tree runs never overwrite a snapshot.** An uncommitted checkout is not reproducible, so it cannot replace a baseline captured from a commit that exists on the remote. The run log says when a snapshot was skipped for this reason.

The view ranks by branch coverage by default, because branches are where untested edge cases hide. Filter by app, metric, threshold, or path fragment. Files with a zero denominator, such as a types-only module with no executable branches, have no measurable coverage and sort last rather than appearing as 0%.

Istanbul summary reports provide lines, statements, functions, and branches per file. LCOV provides lines, functions, and branches; statements are `N/A` because LCOV does not define a separate statement metric.

Select **Show gaps** on any file row to see where its gaps are: functions never called (with their line), line ranges that never ran, and branch points where some paths were never taken. Gap details come from Istanbul's detailed report (`coverage-final.json`, requested automatically for auto-detected Jest and Vitest apps; for manually configured apps, add the `json` coverage reporter next to `json-summary`) or from LCOV. Snapshots captured before this was added show none until the app's next run.

Coverage percentage identifies lines that never executed, not behaviour that was never considered. A file at 100% line coverage with weak assertions still looks complete here. Treat zero-coverage files and low branch coverage as leads to investigate rather than a finished verdict.

When a repository has slices, a **Slice** filter narrows the list to one slice's backend files. Slice pages link here with the filter already applied. **CSV** and **JSON** links download every file matching the current filters; see [Exporting files](#exporting-files).

## Slices: backend coverage by app

A monorepo backend usually serves several frontends, so its overall coverage cannot tell you how well-tested any one app's backend is. A **slice** is the share of the backends that one frontend depends on, and QA Buddy measures and trends each one. Open **Slices** from the repository page.

Ownership is derived from the code, never maintained by hand:

1. **Frontend trace.** Starting from the app's entry point (the module script in `index.html`, otherwise `src/main` or `src/index`), QA Buddy follows runtime imports, including lazy `import()` routes, tsconfig path aliases, the Vite `@/` alias, and pnpm workspace libraries the app imports. Type-only imports, tests, stories, mocks, and Cypress files are ignored, and code the entry point no longer reaches drops out automatically.
2. **Request match.** Every request the traced code makes to a configured backend is matched to a route, in two ways:
   - **Generated client calls.** Functions imported from an orval client (`useGetInspection`, `getGetInspectionQueryKey`, `getInspection`, and so on) map to NestJS endpoints by reproducing the operation ids the OpenAPI document publishes: the method name or an explicit `@ApiOperation({ operationId })`, with path or verb suffixes for duplicates, in the scanner's module registration order from the root module.
   - **Hand-written requests.** `fetch`, `axios`, and similar calls whose URL is built from a backend's base URL name (`` `${import.meta.env.VITE_API_HOST}/users/${id}` ``, `HOST + '/login'`, a local `const base = ...`, a URL held in a variable, or an `axios.create({ baseURL })` client) are matched to routes by path and verb. Interpolated values only fill route parameters, and the most specific route wins.
3. **Backend closure.** From each matched handler it follows runtime imports inside that backend's workspace, including modules a file loads from its own directory at runtime (such as a Sequelize `models/index.js`). Express route indexes that mount every sibling file are treated as routing, not as dependencies, so one shared route file does not pull every route into a slice.

A slice can span several backends. Its totals add the backends together, and the slice page breaks them down per backend.

Slices overlap by design. Shared modules such as auth, data entities, and common utilities belong to every slice that reaches them, because a change there can break any of those apps. For the same reason the slice trend has no "All" tab: a total across slices would count shared files more than once.

Nothing is installed or built. The analysis reads source from a fresh checkout, so a rebuild takes seconds plus clone time, and generated client and OpenAPI files do not need to exist.

### Set up slices for a repository

On the Slices page, open **Slice setup** and add one entry per backend:

| Field | Applies to | Example | Notes |
|---|---|---|---|
| Workspace | All | `apps/idp-api-service` | The backend whose coverage the slices measure. It must also be a tested app in QA Buddy so its per-file coverage exists. |
| Framework | All | NestJS or Express | How routes are discovered: NestJS controllers, or Express `app.use`/`router.get` mounts. |
| Generated client package | NestJS | `@idplans-platform/api-client` | Optional. The `package.json` name frontends import endpoint calls from. |
| Root module | NestJS | `src/app.module.ts` | Relative to the workspace. Used to reproduce operation ids exactly. |
| Entry file | Express | `app.js` | The file that creates the app and mounts its routers. |
| Base URL names | All | `VITE_AUTH_API_HOST, apiHost` | Variables, env keys, or props frontends build this backend's URLs from. Required for Express; add them to a NestJS backend too when some calls bypass the generated client. |

Then list the **Frontends** to slice, for example `apps/idinspect, apps/idcloud`, or leave it blank to slice every `apps/*` workspace whose `package.json` depends on one of the generated client packages. Each slice is named after its directory.

To find base URL names, search a frontend for its API hosts (for example `grep -rn "import.meta.env.VITE_.*HOST" apps/<frontend>/src`) and check the frontend's `.env` files to see which backend each one points at. Shared libraries often take the host as a prop such as `apiHost`; list the prop name too.

Select **Bake slices**. The build runs on the worker between test runs, checks out the repository's default ref (or the local working tree when that box is ticked), and stores one slice per frontend. A frontend that cannot be traced, for example one with no entry point, is skipped with the reason shown next to the build status, and the rest are still stored. A failed build keeps the previous slices.

The recipe and slices live in QA Buddy's SQLite database, not in the repository being measured, so nothing QA Buddy-specific is committed there. On a new machine or a fresh data volume, re-enter the recipe and bake again. The same recipe can also be saved through the API:

```bash
curl -X PUT http://localhost:3003/api/repositories/<repository-id>/slices/config \
  -H 'content-type: application/json' \
  -d '{
    "backends": [
      { "directory": "apps/idp-api-service", "framework": "nestjs",
        "clientPackage": "@idplans-platform/api-client", "baseUrlNames": ["VITE_AUTH_API_V2_HOST"] },
      { "directory": "apps/rpm-api", "framework": "express",
        "entryFile": "app.js", "baseUrlNames": ["VITE_AUTH_API_HOST", "apiHost"] }
    ],
    "frontendDirectories": ["apps/idinspect", "apps/idcloud"]
  }'
curl -X POST http://localhost:3003/api/repositories/<repository-id>/slices/builds -H 'content-type: application/json' -d '{}'
```

### When to rebake

Coverage updates on its own: slice percentages are always calculated from the latest backend coverage snapshots, and every run that tests one of a slice's backends adds a point to its trend. When a run tests only some of a slice's backends, the others contribute their latest snapshot, so the total never drops a backend just because it did not run.

Rebaking is only needed when **which files belong to a slice** may have changed, such as a frontend calling new endpoints, a new backend module, or a refactor that moves code. Rebaking every week or two, or after a large feature lands, is plenty. Each new bake also seeds a trend point from the current snapshot, so a fresh slice has a starting value immediately.

### Reading a slice

- **Measured** counts slice files that appear in the latest coverage reports. Files with no executable code, such as type-only modules and email templates the backend does not collect coverage for, are not reported and do not affect the percentages.
- Precision is per file. If a frontend calls one endpoint in a controller or route file, the whole file and everything it imports count toward that slice.
- The slice page lists the weakest files first, a per-backend breakdown, and every endpoint the frontend calls with the client hook or `file:line` request that reaches it.
- **Requests that matched no route** are listed separately. They usually mean a removed route, a path assembled at runtime, or a backend missing from the recipe; their backend code is not in the slice until they match.

### Exporting files

Coverage gaps and each slice's **Files to improve** panel offer **CSV** and **JSON** downloads of every matching file, unpaged, with each metric's percent, covered, and total counts, the slices that include each file, and its gaps (uncovered functions and line ranges; JSON also lists partly taken branches). Exports follow the filters on screen. The same data is available directly:

```bash
curl -OJ 'http://localhost:3003/api/repositories/<repository-id>/coverage/files/export?slice=idinspect&metric=branches&format=csv'
```

Not yet supported: Ember apps and Ember Data adapters, whose request URLs are built from model names at runtime, and backend frameworks other than NestJS and Express. See [docs/ideas.md](docs/ideas.md) for planned extensions.

## API for scripts and agents

Everything the dashboard shows comes from a JSON API on the same port, so scripts, notebooks, and AI agents can read it directly. `GET /api` lists every endpoint with a one-line summary and its query parameters; it is generated from the same list the server registers, so it stays current.

```bash
curl -s http://localhost:3003/api | jq '.endpoints[] | "\(.method) \(.path)"'
```

Common recipes:

```bash
BASE=http://localhost:3003
# Find a repository id by name.
REPO=$(curl -s $BASE/api/repositories | jq -r '.repositories[] | select(.name == "idplans-platform") | .id')

# Every slice with current coverage, per backend.
curl -s "$BASE/api/repositories/$REPO/slices" | jq '.slices[] | {name, branches: .coverage.branches.percent, backends: [.backends[] | {directory, branches: .coverage.branches.percent}]}'

# One slice's endpoints and unmatched requests.
curl -s "$BASE/api/repositories/$REPO/slices/idinspect" | jq '.slice | {endpoints: (.endpoints | length), unmatchedCalls}'

# The weakest files in a slice, with where their gaps are.
curl -s "$BASE/api/repositories/$REPO/coverage/files/export?slice=idinspect&metric=branches&format=json" \
  | jq '.files[:10][] | {path, branches: .branches.percent, functions: [.details.uncoveredFunctions[]?.name], lines: .details.uncoveredLines}'

# One file's gaps.
curl -s "$BASE/api/repositories/$REPO/coverage/file?path=apps/idp-api-service/src/user/user.service.ts" | jq '.file.details'
```

Things worth knowing when reading the data:

- Per-file coverage and gaps come from each app's **latest snapshot**, which only GitHub-ref runs update. Compare `snapshot.resolvedSha` (or a slice's `coverageSha`) with your checkout before treating a gap as current.
- Slices reflect the commit they were baked from (`resolvedSha`); rebake after endpoint or module changes.
- Queuing runs (`POST /runs`) and slice builds (`POST /slices/builds`) starts real work on the worker; read-only use never changes anything.

A Claude Code skill in [`.claude/skills/qa-buddy`](.claude/skills/qa-buddy/SKILL.md) teaches agents these recipes. It loads automatically for sessions started in this repository. To use it from any directory, such as a checkout of a repository QA Buddy measures, link it into your user skills:

```bash
mkdir -p ~/.claude/skills && ln -s "$(pwd)/.claude/skills/qa-buddy" ~/.claude/skills/qa-buddy
```

## Architecture and security

Compose runs two services from one image:

- `server` owns the Fastify API, React dashboard, SQLite configuration, history, logs, and port `3003`.
- `worker` claims one queued run at a time, clones the requested ref, starts a disposable runner container, streams its output, parses coverage, and cleans up. When no run is queued it picks up slice builds, which only read source in the worker itself and never start a runner container.

The worker also bind-mounts `QA_BUDDY_LOCAL_SOURCE_ROOT` read-only at `/local-source` when that variable is set. Runner containers never receive that mount; the worker copies the archived checkout into the disposable workspace volume instead.

The worker mounts `/var/run/docker.sock`. Access to that socket is effectively host-level Docker control. QA Buddy is intentionally a trusted, local, single-user tool: do not expose it publicly and do not configure repositories you do not trust. Runner containers do not receive the Docker socket, the persistent data volume, or the GitHub clone token, but repository commands can access the network and the temporary checkout.

## Local development

```bash
pnpm install
pnpm build
pnpm test
```

`pnpm dev` starts the API on `3003`, the worker, and Vite on `5173`. Local worker execution still requires Docker and a workspace volume matching `QA_BUDDY_WORKSPACE_VOLUME`; the Compose flow is the supported end-to-end environment.

The default Compose services run `docker/dev-watch.mjs`, which keeps the port-3003 environment synchronized with ordinary source edits without rebuilding the Docker image manually.

Useful endpoints:

- `GET /api/health`
- `GET|POST /api/repositories`
- `GET|POST /api/repositories/:repositoryId/app-groups`
- `PATCH|DELETE /api/app-groups/:groupId`
- `GET|PATCH|DELETE /api/repositories/:repositoryId`
- `POST /api/repositories/:repositoryId/runs`
- `GET /api/repositories/:repositoryId/runs`
- `GET /api/repositories/:repositoryId/coverage` (per-app snapshot metadata)
- `GET /api/repositories/:repositoryId/coverage/files` (ranked per-file coverage; `app`, `metric`, `maxPercent`, `search`, `limit`, `offset`)
- `GET /api/runs/:runId`
- `POST /api/runs/:runId/cancel` (stop a queued or in-flight run)
- `GET /api/runs/:runId/log` (full redacted log download)
- `GET /api/runs/:runId/events` (server-sent events)

The latest 20 runs per repository are retained by default. Override this with `RUN_HISTORY_LIMIT`.
