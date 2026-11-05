---
name: qa-buddy
description: Read test coverage, coverage gaps, and per-app backend "slices" from the local QA Buddy dashboard (http://localhost:3003). Use when asked how well an app, backend, or file is tested; which files, functions, or lines lack tests; what to test next; to draft coverage tickets; or to check slice coverage for a frontend app such as idinspect. Also use before writing unit tests for a file, to aim them at its uncovered functions and branches.
---

# QA Buddy

QA Buddy runs repositories' test suites locally and records coverage per app, per file, and per **slice** (the backend files one frontend app depends on, across one or more backends). Everything is available from a JSON API on `http://localhost:3003`.

## Before you start

1. Check it is running: `curl -sf http://localhost:3003/api/health`. If that fails, tell the user QA Buddy is not running (they start it with `docker compose up -d` in the qa-buddy checkout) rather than guessing at coverage.
2. Discover endpoints: `curl -s http://localhost:3003/api` lists every endpoint with its query parameters. Prefer it over memory if anything below seems out of date.
3. Find the repository id by name:
   ```bash
   curl -s http://localhost:3003/api/repositories | jq -r '.repositories[] | "\(.id)  \(.name)"'
   ```

## Recipes

Set `BASE=http://localhost:3003` and `REPO=<repository id>`.

**Slice overview** (coverage per frontend app, split by backend):
```bash
curl -s "$BASE/api/repositories/$REPO/slices" | jq '{recipe: .config, slices: [.slices[] | {name, endpoints: .endpointCount, files: .fileCount, lines: .coverage.lines.percent, branches: .coverage.branches.percent, backends: [.backends[] | {directory, branches: .coverage.branches.percent}], unmatched: .unmatchedCallCount}]}'
```

**One slice** (every endpoint the frontend calls, and requests that matched no route):
```bash
curl -s "$BASE/api/repositories/$REPO/slices/idinspect" | jq '.slice | {endpoints: [.endpoints[] | "\(.httpMethod | ascii_upcase) \(.path) -> \(.file)"], unmatchedCalls}'
```

**Weakest files with their gaps** (unpaged; filter by `slice`, `app`, `maxPercent`, `search`; rank with `metric`):
```bash
curl -s "$BASE/api/repositories/$REPO/coverage/files/export?slice=idinspect&metric=branches&format=json" \
  | jq '.files[:15][] | {path, slices, branches: .branches.percent, functions: [.details.uncoveredFunctions[]? | "\(.name):\(.line)"], lines: .details.uncoveredLines}'
```

**One file's gaps** (before writing tests for it):
```bash
curl -s "$BASE/api/repositories/$REPO/coverage/file?path=<repository-relative path>" | jq '.file | {lines, branches, details, snapshot}'
```
`details.uncoveredFunctions` are functions never called, `details.uncoveredLines` are inclusive line ranges that never ran, and `details.uncoveredBranches` are branch points where some paths were never taken. `details` is null when the app's last run did not produce a detailed report.

**Trend over time:** `GET /api/repositories/$REPO/slices/history` (per slice) and `GET /api/repositories/$REPO/coverage/history` (per app). Each entry is one completed run.

## Reading the data correctly

- Coverage and gaps come from each app's **latest snapshot**, which only runs against a GitHub ref update. Compare `snapshot.resolvedSha` (or a slice's `coverageSha`) with the checkout you are working in; line numbers in gaps refer to that commit. Say so when they differ.
- Slices are traced from the commit in the slice's `resolvedSha`. Files added since then are not in the slice until it is rebaked.
- Slices overlap on purpose: shared files count toward every slice that reaches them. Do not add slice totals together.
- Files missing from coverage (type-only modules, templates the backend does not collect) are not gaps.
- Coverage shows code that never ran, not behaviour that was never checked. Treat gaps as leads.

## Changing things

Reading is always safe. These start real work on the user's machine, so confirm with the user first:

- `POST /api/repositories/$REPO/runs` with `{ "ref"?: string, "apps"?: string[], "useLocalWorkingTree"?: boolean }` queues a test run (minutes to tens of minutes).
- `POST /api/repositories/$REPO/slices/builds` with `{}` rebakes slices (seconds plus clone time).
- `PUT /api/repositories/$REPO/slices/config` replaces the slice recipe.

After queuing a run, follow it with `GET /api/runs/<runId>` until `status` is `passed`, `failed`, `timed_out`, or `interrupted`.
