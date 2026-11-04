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
    useLocalWorkingTree: false,
    dirty: false,
    cancelRequested: false,
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
    additionalWorkspaces: [],
    excludedWorkspaces: [],
    environmentAllowlist: [],
    autoDetect: true,
    coverageGoal: null,
    apps: [],
    createdAt: "2026-09-09T11:00:00.000Z",
    updatedAt: "2026-09-09T11:00:00.000Z",
    latestRun: previousRun,
    latestCompletedRun: previousRun,
    selectableApps,
    appGroups: [],
    runs: [previousRun]
  };
}

function renderPage(repository = repositoryFixture()) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.method === "POST"
      ? { run: { id: "run-new" } }
      : String(input).endsWith("/coverage/history") ? { entries: [] } : { repository };
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
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => !String(url).endsWith("/coverage/history"))).toHaveLength(2));
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

  it("hides the local working tree toggle until a checkout path is configured", async () => {
    renderPage();
    await screen.findByText("3 of 3 selected");
    expect(screen.queryByRole("checkbox", { name: /local working tree/i })).toBeNull();
  });

  it("sends the local working tree flag and disables the ref input", async () => {
    const { fetchMock, user } = renderPage({ ...repositoryFixture(), localPath: "platform" });
    await screen.findByText("3 of 3 selected");

    const toggle = screen.getByRole("checkbox", { name: /local working tree/i });
    await user.click(toggle);

    const refInput = screen.getByLabelText("Test branch, tag, or commit SHA");
    expect(refInput.hasAttribute("disabled")).toBe(true);
    // The whole field reads as inactive, not just the input element.
    expect(refInput.closest("label")?.className).toContain("field-disabled");

    await user.click(screen.getByRole("button", { name: /Run all apps/ }));
    await screen.findByText("Run queued");
    const postRequest = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(postRequest?.[1]?.body))).toEqual({
      ref: "main",
      useLocalWorkingTree: true
    });
  });

  it("offers a stop control while a run is in flight and posts the cancellation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const repository = repositoryFixture();
    const running = {
      ...repository,
      runs: [{ ...repository.runs[0]!, id: "run-active", status: "building" as const }]
    };
    const { fetchMock, user } = renderPage(running);

    const stop = await screen.findByRole("button", { name: /Stop run/ });
    await user.click(stop);

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url) === "/api/runs/run-active/cancel" && init?.method === "POST"
        )
      ).toBe(true)
    );
    confirmSpy.mockRestore();
  });

  it("hides the stop control when no run is in flight", async () => {
    renderPage();
    await screen.findByText("3 of 3 selected");
    expect(screen.queryByRole("button", { name: /Stop run/ })).toBeNull();
  });

  const groupFixture = (appNames: string[], name = "Nightly") => ({
    id: "group-1",
    repositoryId,
    name,
    appNames,
    createdAt: "2026-09-09T12:00:00.000Z",
    updatedAt: "2026-09-09T12:00:00.000Z"
  });

  it("filters applications by name and by working directory", async () => {
    const { user } = renderPage();
    await screen.findByText("3 of 3 selected");

    const filter = screen.getByLabelText("Filter applications");
    await user.type(filter, "worker");
    expect(screen.getByRole("checkbox", { name: /Worker/ })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /^API/ })).toBeNull();

    await user.clear(filter);
    // The path is often the distinguishing part, so it matches too.
    await user.type(filter, "apps/web");
    expect(screen.getByRole("checkbox", { name: /Web/ })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Worker/ })).toBeNull();
  });

  it("warns when a filter hides applications that are still selected", async () => {
    const { user } = renderPage();
    await screen.findByText("3 of 3 selected");

    await user.type(screen.getByLabelText("Filter applications"), "worker");

    expect(screen.getByText(/2 selected apps are hidden by the current filter/)).toBeTruthy();
    // The true total is still reported, so nothing runs invisibly.
    expect(screen.getByText("3 of 3 selected")).toBeTruthy();
  });

  it("limits select all to the visible matches while a filter is active", async () => {
    const { user } = renderPage();
    await screen.findByText("3 of 3 selected");
    await user.click(screen.getByRole("button", { name: "Unselect all" }));

    await user.type(screen.getByLabelText("Filter applications"), "worker");
    await user.click(screen.getByRole("button", { name: /Select all 1 matching/ }));

    expect(screen.getByText("1 of 3 selected")).toBeTruthy();
  });

  it("applies a saved group, replacing the current selection", async () => {
    const repository = { ...repositoryFixture(), appGroups: [groupFixture(["API", "Web"])] };
    const { user } = renderPage(repository);
    await screen.findByText("3 of 3 selected");

    await user.click(screen.getByRole("button", { name: /Nightly/ }));

    expect(screen.getByText("2 of 3 selected")).toBeTruthy();
    const checked = screen.getAllByRole("checkbox").filter((box) => (box as HTMLInputElement).checked);
    expect(checked).toHaveLength(2);
  });

  it("selects only the apps in a group that still exist and says how many are gone", async () => {
    const repository = {
      ...repositoryFixture(),
      appGroups: [groupFixture(["API", "Retired", "Also retired"])]
    };
    const { user } = renderPage(repository);
    await screen.findByText("3 of 3 selected");

    expect(screen.getByText(/2 no longer detected/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Nightly/ }));

    // A stale name must never reach the API, which rejects unknown selections.
    expect(screen.getByText("1 of 3 selected")).toBeTruthy();
  });

  it("saves the current selection as a named group", async () => {
    const { fetchMock, user } = renderPage();
    await screen.findByText("3 of 3 selected");
    await user.click(screen.getByRole("button", { name: "Unselect all" }));
    await user.click(screen.getByRole("checkbox", { name: /Worker/ }));

    await user.click(screen.getByRole("button", { name: /Save selection as group/ }));
    await user.type(screen.getByLabelText("Group name"), "Nightly smoke");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) => String(url).endsWith("/app-groups") && init?.method === "POST"
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        name: "Nightly smoke",
        appNames: ["Worker"]
      });
    });
  });

  it("offers to update a group only once the selection has drifted from it", async () => {
    const repository = { ...repositoryFixture(), appGroups: [groupFixture(["API", "Web"])] };
    const { user } = renderPage(repository);
    await screen.findByText("3 of 3 selected");

    await user.click(screen.getByRole("button", { name: /Nightly/ }));
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: /Worker/ }));
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
  });

  it("moves a group later by sending the full new order", async () => {
    const repository = {
      ...repositoryFixture(),
      appGroups: [groupFixture(["API"], "Backend"), { ...groupFixture(["Web"], "Frontend"), id: "group-2" }]
    };
    const { fetchMock, user } = renderPage(repository);
    await screen.findByText("3 of 3 selected");

    expect((screen.getByRole("button", { name: "Move Backend earlier" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move Frontend later" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Move Backend later" }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/app-groups/order") && init?.method === "PUT");
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({ groupIds: ["group-2", "group-1"] });
    });
  });
});
