// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppRun, RunDetail, RunStatus } from "@qa-buddy/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RunDetailPage } from "./RunDetailPage";

const repositoryId = "repository-1";

function appRun(name: string, position: number): AppRun {
  return {
    id: `app-run-${position}`,
    runId: "run-original",
    name,
    workingDirectory: `apps/${name.toLowerCase()}`,
    testCommand: "pnpm test",
    coverageFormat: "istanbul-summary-json",
    coveragePath: `apps/${name.toLowerCase()}/coverage/coverage-summary.json`,
    position,
    status: "passed",
    exitCode: 0,
    coverage: null,
    coverageError: null,
    testResults: null,
    testResultsError: null,
    startedAt: "2026-09-09T12:00:00.000Z",
    finishedAt: "2026-09-09T12:01:00.000Z"
  };
}

function runFixture(status: RunStatus = "passed", selectedApps: string[] | null = ["API"]): RunDetail {
  return {
    id: "run-original",
    repositoryId,
    requestedRef: "feature/coverage",
    resolvedSha: "0123456789abcdef",
    status,
    error: null,
    selectedApps,
    createdAt: "2026-09-09T12:00:00.000Z",
    startedAt: "2026-09-09T12:00:00.000Z",
    finishedAt: status === "passed" ? "2026-09-09T12:01:00.000Z" : null,
    appRuns: [appRun("API", 0)],
    configurationSnapshot: {
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
      selectedApps
    }
  };
}

function renderPage(run = runFixture(), postResponseStatus = 202) {
  class FakeEventSource {
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal("EventSource", FakeEventSource);

  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      return {
        ok: postResponseStatus < 400,
        status: postResponseStatus,
        json: async () => postResponseStatus < 400 ? { run: { id: "run-new" } } : { error: "A run is already active" }
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ run })
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter
      initialEntries={["/runs/run-original"]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/runs/run-new" element={<div>Re-run queued</div>} />
        <Route path="/runs/:runId" element={<RunDetailPage />} />
      </Routes>
    </MemoryRouter>
  );

  return { fetchMock, user: userEvent.setup() };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("run detail re-run action", () => {
  it("queues a fresh run with the original ref and selected apps", async () => {
    const { fetchMock, user } = renderPage();
    await user.click(await screen.findByRole("button", { name: "Re-run" }));

    await screen.findByText("Re-run queued");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const postRequest = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(postRequest?.[0]).toBe(`/api/repositories/${repositoryId}/runs`);
    expect(JSON.parse(String(postRequest?.[1]?.body))).toEqual({
      ref: "feature/coverage",
      apps: ["API"]
    });
  });

  it("reruns every app when the original run was not filtered", async () => {
    const { fetchMock, user } = renderPage(runFixture("passed", null));
    await user.click(await screen.findByRole("button", { name: "Re-run" }));

    await screen.findByText("Re-run queued");
    const postRequest = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(postRequest?.[1]?.body))).toEqual({ ref: "feature/coverage" });
  });

  it("disables re-running while the displayed run is active", async () => {
    renderPage(runFixture("testing"));
    const button = await screen.findByRole("button", { name: "Re-run" });

    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("title")).toContain("Wait for this run to finish");
  });

  it("keeps the run visible when queueing is rejected", async () => {
    const { user } = renderPage(runFixture(), 409);
    await user.click(await screen.findByRole("button", { name: "Re-run" }));

    expect((await screen.findByRole("alert")).textContent).toContain("A run is already active");
    expect(screen.getByRole("heading", { name: "Example monorepo" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Re-run" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears the queueing state when the router reuses the page for the new run", async () => {
    const originalRun = runFixture();
    const queuedRun = {
      ...runFixture("queued"),
      id: "run-new",
      resolvedSha: null,
      startedAt: null,
      appRuns: originalRun.appRuns.map((app) => ({
        ...app,
        id: "app-run-new",
        runId: "run-new",
        status: "pending" as const,
        exitCode: null,
        startedAt: null,
        finishedAt: null
      }))
    };

    class FakeEventSource {
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      status: init?.method === "POST" ? 202 : 200,
      json: async () => init?.method === "POST"
        ? { run: { id: "run-new" } }
        : { run: String(input).endsWith("/run-new") ? queuedRun : originalRun }
    } as Response));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <MemoryRouter
        initialEntries={["/runs/run-original"]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/runs/:runId" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    await user.click(await screen.findByRole("button", { name: "Re-run" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => input === "/api/runs/run-new")).toBe(true);
    });
    const rerunButton = await screen.findByRole("button", { name: "Re-run" });
    expect((rerunButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Queueing…" })).toBeNull();
  });
});
