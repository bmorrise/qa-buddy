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
- A runner image that provides `/bin/sh` and the required language tools.
- An optional setup command that runs once at the repository root.
- An optional build-command override that runs once after setup and before any selected app tests.
- A per-app test-worker limit, defaulting to `2`, for auto-detected Jest and Vitest commands. Parallel Jest workers are recycled after 1 GiB so long suites cannot grow a worker until Node exhausts its heap; scripts already using `--runInBand` keep their intentional serial execution.
- A timeout from 1 to 120 minutes.
- Optional environment variable names to pass from the worker to the runner.
- Automatic pnpm/Turborepo app detection, or one or more manually configured apps.

### Automatic pnpm/Turborepo detection

Enable **Auto-detect pnpm/Turborepo apps** when the repository has a root `pnpm-workspace.yaml`. On every fresh clone, QA Buddy:

1. Expands the workspace package globs without following symlinks outside the checkout.
2. Prioritizes workspaces under `apps/`; if there is no `apps/` group, it considers all workspaces.
3. Reads each workspace `package.json` and selects `test:coverage`, then `test:cov`, `coverage`, and finally `test` in that order.
4. Runs the selected script from that app's workspace directory.
5. Adds Jest or Vitest's JSON test reporter, requires an Istanbul-compatible JSON coverage summary for both runners, and records exact passed, failed, skipped, and todo test cases.
6. Limits parallel Jest and Vitest workers to the configured per-app value, preserves serial Jest scripts, uses version-compatible Vitest worker flags, and ignores compiled `dist` output during Jest coverage collection.
7. Clears that app's old structured-test and coverage files before execution, then discovers newly generated `coverage/coverage-summary.json` or `coverage/lcov.info`, including repository-root `coverage/apps/...` layouts and both JSON/LCOV files in safe shared Jest `coverageDirectory` values from package.json. This prevents a failed app from inheriting another app's shared or stale report.

The presence of `turbo.json` is reported in the run log, but pnpm workspace configuration remains the source of truth for app directories. Workspaces without a supported test script are ignored. Detection fails with an actionable error when no testable apps are found.

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

The run detail page provides an expandable test-case readout for auto-detected Jest and Vitest apps. It records test names, source test files, durations, statuses, and bounded failure messages. For a manually configured command, QA Buddy will also consume a Jest-compatible JSON report written to `.qa-buddy-test-results.json` in the app working directory. Other test runners continue to use the full redacted log as their detailed readout.

## Environment pass-through

Values belong in `.env`, not in the dashboard. Add only their names to a repository's environment allowlist. The worker reads those values and passes only the selected variables into that repository's runner. Values are redacted from logs.

`GITHUB_TOKEN` is reserved for cloning and is rejected from runner allowlists. Use a separate, narrowly scoped package token such as `NPM_TOKEN` when tests need private packages.

If a repository's `.npmrc` references a named variable, put that variable in `.env` and add only its name to the repository's environment allowlist. For example, ID Plans uses `GITHUB_IDP_REGISTRY`. GitHub's npm package registry currently requires a personal access token (classic) with at least `read:packages`; keep this package token separate from the repository clone token.

## Architecture and security

Compose runs two services from one image:

- `server` owns the Fastify API, React dashboard, SQLite configuration, history, logs, and port `3003`.
- `worker` claims one queued run at a time, clones the requested ref, starts a disposable runner container, streams its output, parses coverage, and cleans up.

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
- `GET|PATCH|DELETE /api/repositories/:repositoryId`
- `POST /api/repositories/:repositoryId/runs`
- `GET /api/repositories/:repositoryId/runs`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/log` (full redacted log download)
- `GET /api/runs/:runId/events` (server-sent events)

The latest 20 runs per repository are retained by default. Override this with `RUN_HISTORY_LIMIT`.
