/**
 * Every API endpoint, served at `GET /api` so scripts and agents can discover
 * the API in one call. A test keeps this list in step with the registered
 * routes, so add an entry whenever a route is added.
 */
export interface ApiEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  /** Query parameters, when the endpoint takes any. */
  query?: Record<string, string>;
}

export const apiEndpoints: ApiEndpoint[] = [
  { method: "GET", path: "/api", summary: "This list of endpoints." },
  { method: "GET", path: "/api/health", summary: "Liveness check." },

  { method: "GET", path: "/api/repositories", summary: "All repositories with their latest and latest completed runs. Use it to find a repository id by name." },
  { method: "POST", path: "/api/repositories", summary: "Create a repository configuration." },
  { method: "GET", path: "/api/repositories/:repositoryId", summary: "One repository with retained runs, selectable apps, and app groups." },
  { method: "PATCH", path: "/api/repositories/:repositoryId", summary: "Update a repository configuration." },
  { method: "DELETE", path: "/api/repositories/:repositoryId", summary: "Delete a repository and everything recorded for it." },

  { method: "POST", path: "/api/repositories/:repositoryId/runs", summary: "Queue a run. Body: { ref?, apps?, useLocalWorkingTree? }." },
  { method: "GET", path: "/api/repositories/:repositoryId/runs", summary: "Retained runs for one repository." },
  { method: "GET", path: "/api/runs/:runId", summary: "One run with per-app status, coverage, and test results." },
  { method: "POST", path: "/api/runs/:runId/cancel", summary: "Stop a queued or running run." },
  { method: "GET", path: "/api/runs/:runId/log", summary: "A run's log as text." },
  { method: "GET", path: "/api/runs/:runId/events", summary: "Server-sent events streaming a run's log." },

  { method: "GET", path: "/api/repositories/:repositoryId/app-groups", summary: "Saved app groups." },
  { method: "POST", path: "/api/repositories/:repositoryId/app-groups", summary: "Save an app group. Body: { name, appNames }." },
  { method: "PUT", path: "/api/repositories/:repositoryId/app-groups/order", summary: "Reorder app groups. Body: { groupIds }." },
  { method: "PATCH", path: "/api/app-groups/:groupId", summary: "Rename an app group or replace its apps." },
  { method: "DELETE", path: "/api/app-groups/:groupId", summary: "Delete an app group." },

  { method: "GET", path: "/api/repositories/:repositoryId/coverage", summary: "Current per-app coverage snapshots." },
  { method: "GET", path: "/api/repositories/:repositoryId/coverage/history", summary: "Per-app coverage and test counts for every completed run." },
  {
    method: "GET",
    path: "/api/repositories/:repositoryId/coverage/files",
    summary: "Per-file coverage from the snapshots, weakest first, paged (at most 1000 per page).",
    query: {
      app: "App name, as shown in snapshots",
      slice: "Slice name",
      metric: "lines | statements | functions | branches (ranking metric, default lines)",
      maxPercent: "Only files at or below this percent",
      search: "Path fragment",
      limit: "Page size, 1-1000",
      offset: "Rows to skip"
    }
  },
  {
    method: "GET",
    path: "/api/repositories/:repositoryId/coverage/files/export",
    summary: "Every matching file, unpaged, with the slices that include it and its gaps (uncovered lines, functions, branches).",
    query: {
      format: "csv (default) | json",
      app: "App name",
      slice: "Slice name",
      metric: "Ranking metric",
      maxPercent: "Only files at or below this percent",
      search: "Path fragment"
    }
  },
  {
    method: "GET",
    path: "/api/repositories/:repositoryId/coverage/file",
    summary: "One file's coverage and gaps: uncovered line ranges, never-called functions, and partly taken branches.",
    query: { path: "Repository-relative file path, for example apps/api/src/users/users.service.ts" }
  },

  { method: "GET", path: "/api/repositories/:repositoryId/slices", summary: "Slice recipe, recent slice builds, and every slice with current coverage per backend." },
  { method: "PUT", path: "/api/repositories/:repositoryId/slices/config", summary: "Save the slice recipe. Body: { backends: [...], frontendDirectories }." },
  { method: "POST", path: "/api/repositories/:repositoryId/slices/builds", summary: "Queue a slice build. Body: { ref?, useLocalWorkingTree? }." },
  { method: "GET", path: "/api/repositories/:repositoryId/slices/history", summary: "Slice trend points, shaped like coverage history with the slice name as appName." },
  { method: "GET", path: "/api/repositories/:repositoryId/slices/:sliceName", summary: "One slice: per-backend coverage, every endpoint the frontend calls, and requests that matched no route." },
  { method: "GET", path: "/api/slice-builds/:buildId/log", summary: "A slice build's log as text." }
];
