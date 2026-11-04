# Future ideas

Ideas worth building later. Not commitments; move an item out of here once it is planned.

## To-do

Small, agreed improvements waiting for a slot.

- **Look up repositories by name.** Accept a repository name wherever an id is taken (or add `GET /api/repositories/by-name/:name`), so scripts and agents can skip the id lookup step.
- **Which slices use this file.** `GET /api/repositories/:id/coverage/file` could list the slices (and the endpoints in each) that reach the file, answering "who is affected if this changes?" in one call. The export already carries slice membership; this is the single-file version, and it pairs with the change alerts idea below.

## Slices (backend coverage per frontend app)

- **Weight slices by real traffic (Sentry).** Use Sentry traces or request logs, grouped by calling frontend, to rank a slice's endpoints by how often they are hit in production. Turns "uncovered files in my slice" into "uncovered files behind my busiest endpoints". Needs requests tagged with the calling app.
- **Alert on changes to files in my slice.** Between two runs, list files in a slice that changed (git diff of the resolved SHAs), and flag the ones another team changed in shared code. Most useful for shared modules an app owner does not work in day to day.
- **Rebuild slices automatically on every run.** The endpoint trace is static analysis on the checkout a run already has, so it could run each time instead of only from the rebuild button, keeping the map tied to the exact commit tested.
- **Endpoint-level coverage.** Use per-function Istanbul data (`coverage-final.json`) to report coverage for each controller method and the service methods it calls, rather than whole files.
