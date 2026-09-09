// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppInput, AppRun, AppRunStatus, RepositoryDetail } from "@qa-buddy/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RepositoryDetailPage } from "./RepositoryDetailPage";

const repositoryId = "repository-1";
const selectableApps: AppInput[] = [
  {
    name: "API",
    workingDirectory: "apps/api",
    testCommand: "pnpm test",
    coverageFormat: "istanbul-summary-json",
    coveragePath: "apps/api/coverage/coverage-summary.json"
  },
  {
    name: "Worker",
    workingDirectory: "apps/worker",
    testCommand: "pnpm test",
    coverageFormat: "istanbul-summary-json",
    coveragePath: "apps/worker/coverage/coverage-summary.json"
  },
  {
    name: "Web",
    workingDirectory: "apps/web",
    testCommand: "pnpm test",
    coverageFormat: "istanbul-summary-json",
    coveragePath: "apps/web/coverage/coverage-summary.json"
  }
];

function appRun(app: AppInput, status: AppRunStatus, position: number): AppRun {
  return {
    ...app,
    id: `app-run-${position}`,
    runId: "run-previous",
    position,
    status,
    exitCode: status === "failed" ? 1 : 0,
    coverage: null,
    coverageError: status === "failed" ? "Test command exited with code 1" : null,
    testResults: null,
    testResultsError: null,
    startedAt: "2026-09-09T12:00:00.000Z",
    finishedAt: "2026-09-09T12:01:00.000Z"
  };
}

function repositoryFixture(): RepositoryDetail {
  const previousRun = {
    id: "run-previous",
    repositoryId,
    requestedRef: "main",
    resolvedSha: "0123456789abcdef",
    status: "failed" as const,
    error: "2 apps failed",
    selectedApps: null,
    createdAt: "2026-09-09T12:00:00.000Z",
    startedAt: "2026-09-09T12:00:00.000Z",
    finishedAt: "2026-09-09T12:01:00.000Z",
    appRuns: [
      appRun(selectableApps[0]!, "failed", 0),
      appRun(selectableApps[1]!, "passed", 1),
      appRun(selectableApps[2]!, "failed", 2)
    ]
  };

  return {
    id: repositoryId,
    name: "Example monorepo",
    githubUrl: "https://github.com/example/monorepo.git",
    defaultRef: "main",
    runnerImage: "node:22-bookworm",
    setupCommand: "pnpm install",
    buildCommand: "pnpm build",
    testWorkerLimit: 2,
    timeoutMinutes: 30,
    environmentAllowlist: [],
    autoDetect: true,
    apps: [],
    createdAt: "2026-09-09T11:00:00.000Z",
    updatedAt: "2026-09-09T11:00:00.000Z",
    latestRun: previousRun,
    selectableApps,
    runs: [previousRun]
  };
}

function renderPage(repository = repositoryFixture()) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.method === "POST" ? { run: { id: "run-new" } } : { repository };
    return {
      ok: true,
      status: 200,
      json: async () => body
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter
      initialEntries={[`/repositories/${repositoryId}`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/repositories/:repositoryId" element={<RepositoryDetailPage />} />
        <Route path="/runs/:runId" element={<div>Run queued</div>} />
      </Routes>
    </MemoryRouter>
  );
  return { fetchMock, user: userEvent.setup() };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("repository app selection", () => {
  it("unselects and reselects every app", async () => {
    const { user } = renderPage();
    expect(await screen.findByText("3 of 3 selected")).toBeTruthy();
    expect(screen.getAllByRole("checkbox").every((checkbox) => (checkbox as HTMLInputElement).checked)).toBe(true);

    await user.click(screen.getByRole("button", { name: "Unselect all" }));

    expect(screen.getByText("0 of 3 selected")).toBeTruthy();
    expect(screen.getAllByRole("checkbox").every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);
    expect((screen.getByRole("button", { name: /Run 0 apps/ }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Select all" }));

    expect(screen.getByText("3 of 3 selected")).toBeTruthy();
    expect(screen.getAllByRole("checkbox").every((checkbox) => (checkbox as HTMLInputElement).checked)).toBe(true);
    expect((screen.getByRole("button", { name: /Run all apps/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("allows one app to be selected after clearing the picker", async () => {
    const { user } = renderPage();
    await screen.findByText("3 of 3 selected");
    await user.click(screen.getByRole("button", { name: "Unselect all" }));
    await user.click(screen.getByRole("checkbox", { name: /Worker/ }));

    expect(screen.getByText("1 of 3 selected")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Run 1 app/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("selects only apps that failed in the latest run", async () => {
    const { user } = renderPage();
    await screen.findByText("3 of 3 selected");
    await user.click(screen.getByRole("button", { name: "Select failed" }));

    const checkedApps = screen
      .getAllByRole("checkbox")
      .map((checkbox) => (checkbox as HTMLInputElement).checked);
    expect(screen.getByText("2 of 3 selected")).toBeTruthy();
    expect(checkedApps).toEqual([true, false, true]);
  });

  it("submits only the selected app names", async () => {
    const { fetchMock, user } = renderPage();
    await screen.findByText("3 of 3 selected");
    await user.click(screen.getByRole("button", { name: "Unselect all" }));
    await user.click(screen.getByRole("checkbox", { name: /Worker/ }));
    await user.click(screen.getByRole("button", { name: /Run 1 app/ }));

    await screen.findByText("Run queued");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const postRequest = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(postRequest?.[1]?.body))).toEqual({
      ref: "main",
      apps: ["Worker"]
    });
  });

  it("omits the app filter when every app is selected", async () => {
    const { fetchMock, user } = renderPage();
    await screen.findByText("3 of 3 selected");
    await user.click(screen.getByRole("button", { name: /Run all apps/ }));

    await screen.findByText("Run queued");
    const postRequest = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(postRequest?.[1]?.body))).toEqual({ ref: "main" });
  });
});
