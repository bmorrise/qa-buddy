// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Slice, SliceConfig, SliceDetail, SliceOverview } from "@qa-buddy/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { wedgePath } from "../components/Pizza";
import { SliceDetailPage } from "./SliceDetailPage";
import { SlicesPage } from "./SlicesPage";

const repositoryId = "repository-1";
const metric = (covered: number, total: number) => ({ covered, total, percent: Math.round((covered / total) * 1_000) / 10 });

const config: SliceConfig = {
  backends: [
    { directory: "apps/api", framework: "nestjs", clientPackage: "@acme/api-client", rootModule: "src/app.module.ts", entryFile: null, baseUrlNames: [] },
    { directory: "apps/rpm-api", framework: "express", clientPackage: null, rootModule: null, entryFile: "app.js", baseUrlNames: ["VITE_AUTH_API_HOST"] }
  ],
  frontendDirectories: []
};

const slice: Slice = {
  name: "idinspect",
  frontendDirectory: "apps/idinspect",
  buildId: "build-1",
  resolvedSha: "0123456789abcdef",
  builtAt: "2026-11-04T12:00:00.000Z",
  endpointCount: 180,
  fileCount: 640,
  measuredFileCount: 557,
  coverage: { lines: metric(588, 1000), statements: metric(590, 1000), functions: metric(442, 1000), branches: metric(423, 1000) },
  coverageCapturedAt: "2026-11-04T11:00:00.000Z",
  coverageSha: "fedcba9876543210",
  backends: [
    { directory: "apps/api", endpointCount: 174, fileCount: 480, measuredFileCount: 420, coverage: { lines: metric(500, 800), statements: null, functions: null, branches: metric(380, 800) } },
    { directory: "apps/rpm-api", endpointCount: 6, fileCount: 160, measuredFileCount: 137, coverage: { lines: metric(88, 200), statements: null, functions: null, branches: metric(43, 200) } }
  ],
  unmatchedCallCount: 1
};

interface Requests {
  calls: Array<{ url: string; method: string; body: unknown }>;
}

function stubFetch(overview: SliceOverview, extra: Record<string, unknown> = {}): Requests {
  const requests: Requests = { calls: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      let body: unknown;
      if (url.endsWith("/slices/config")) body = { config: JSON.parse(String(init!.body)) };
      else if (url.endsWith("/slices/builds")) body = { build: { id: "build-2" } };
      else if (url.endsWith("/slices/history")) body = { entries: [] };
      else if (url.endsWith("/slices")) body = overview;
      else if (url.includes("/coverage/files")) body = extra["/coverage/files"] ?? { files: [], total: 0, limit: 15, offset: 0 };
      else if (url.includes("/coverage/file?")) body = extra["/coverage/file"];
      else {
        const match = Object.keys(extra).find((key) => url.endsWith(key));
        body = match ? extra[match] : { repository: { id: repositoryId, name: "Platform", localPath: null, coverageGoal: 60 } };
      }
      return { ok: true, status: method === "POST" ? 202 : 200, json: async () => body } as Response;
    })
  );
  return requests;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/repositories/:repositoryId/slices" element={<SlicesPage />} />
        <Route path="/repositories/:repositoryId/slices/:sliceName" element={<SliceDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SlicesPage", () => {
  it("asks for a recipe before slices can be baked, then saves it", async () => {
    const requests = stubFetch({ config: null, builds: [], slices: [] });
    renderAt(`/repositories/${repositoryId}/slices`);

    expect(await screen.findByRole("heading", { name: "No slices yet" })).toBeTruthy();
    expect((screen.getByRole("button", { name: /Bake slices/ }) as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(screen.getByLabelText(/^Workspace/), "apps/api");
    await userEvent.type(screen.getByLabelText(/Generated client package/), "@acme/api-client");
    await userEvent.click(screen.getByRole("button", { name: /Add backend/ }));
    const second = screen.getAllByRole("group").find((group) => group.textContent?.startsWith("Backend 2"))!;
    await userEvent.type(within(second).getByLabelText(/^Workspace/), "apps/rpm-api");
    expect((within(second).getByLabelText(/Framework/) as HTMLSelectElement).value).toBe("express");
    await userEvent.type(within(second).getByLabelText(/Base URL names/), "VITE_AUTH_API_HOST, apiHost");
    await userEvent.type(screen.getByLabelText(/^Frontends/), "apps/idinspect, apps/idcloud");
    await userEvent.click(screen.getByRole("button", { name: "Save recipe" }));

    await waitFor(() => expect(requests.calls.some((call) => call.method === "PUT")).toBe(true));
    expect(requests.calls.find((call) => call.method === "PUT")!.body).toEqual({
      backends: [
        { directory: "apps/api", framework: "nestjs", clientPackage: "@acme/api-client", rootModule: "src/app.module.ts", entryFile: null, baseUrlNames: [] },
        { directory: "apps/rpm-api", framework: "express", clientPackage: null, rootModule: null, entryFile: "app.js", baseUrlNames: ["VITE_AUTH_API_HOST", "apiHost"] }
      ],
      frontendDirectories: ["apps/idinspect", "apps/idcloud"]
    });
    await waitFor(() => expect((screen.getByRole("button", { name: /Bake slices/ }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("shows each slice as a pizza for the chosen metric and starts a rebuild", async () => {
    const requests = stubFetch({
      config,
      builds: [
        {
          id: "build-1",
          repositoryId,
          status: "passed",
          requestedRef: "main",
          useLocalWorkingTree: false,
          resolvedSha: "0123456789abcdef",
          dirty: false,
          error: null,
          sliceCount: 1,
          skipped: [{ frontendDirectory: "apps/docs", reason: "no entry point" }],
          config,
          createdAt: "2026-11-04T12:00:00.000Z",
          startedAt: "2026-11-04T12:00:00.000Z",
          finishedAt: "2026-11-04T12:00:02.000Z"
        }
      ],
      slices: [slice]
    });
    renderAt(`/repositories/${repositoryId}/slices`);

    const card = await screen.findByRole("link", { name: /idinspect/ });
    expect(within(card).getByRole("img", { name: "idinspect: 42.3% branches covered" })).toBeTruthy();
    expect(within(within(card).getByRole("list", { name: "Coverage by backend" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "api47.5%",
      "rpm-api21.5%"
    ]);
    expect(screen.getByText("api + rpm-api · every app using a client")).toBeTruthy();
    expect(screen.getByText("Edit recipe")).toBeTruthy();
    expect(within(card).getByText("640")).toBeTruthy();
    expect(screen.getByText(/Skipped apps\/docs \(no entry point\)/)).toBeTruthy();

    await userEvent.click(screen.getAllByRole("button", { name: "Functions" })[0]!);
    expect(within(card).getByText("44.2%")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /Rebake slices/ }));
    await waitFor(() => expect(requests.calls.some((call) => call.method === "POST" && call.url.endsWith("/slices/builds"))).toBe(true));
    expect(requests.calls.some((call) => call.url.endsWith("/slices/history"))).toBe(true);
  });
});

describe("SliceDetailPage", () => {
  it("lists the endpoints the frontend calls and filters them", async () => {
    const detail: SliceDetail = {
      ...slice,
      endpoints: [
        { backendDirectory: "apps/api", httpMethod: "get", path: "/inspection-instance/{id}", controller: "InspectionInstanceController", methodKey: "getInspection", file: "apps/api/src/inspection.controller.ts", clientNames: ["useGetInspection"] },
        { backendDirectory: "apps/api", httpMethod: "post", path: "/work-order", controller: "WorkOrderController", methodKey: "createWorkOrder", file: "apps/api/src/work-order.controller.ts", clientNames: ["useCreateWorkOrder"] },
        { backendDirectory: "apps/rpm-api", httpMethod: "post", path: "/login", controller: "login", methodKey: "", file: "apps/rpm-api/routes/login.js", clientNames: ["libs/react-auth/src/queries/useGetUserQuery.ts:21"] }
      ],
      unmatchedCalls: [{ backendDirectory: "apps/rpm-api", site: "apps/idinspect/src/odd.ts:9", method: "put", path: "/mystery/{}" }]
    };
    const requests = stubFetch({ config, builds: [], slices: [slice] }, { "/slices/idinspect": { slice: detail } });
    renderAt(`/repositories/${repositoryId}/slices/idinspect`);

    expect(await screen.findByRole("heading", { name: "idinspect" })).toBeTruthy();
    expect(screen.getByText("InspectionInstanceController.getInspection")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Backends" })).toBeTruthy();
    expect(screen.getByText("1 request matched no route")).toBeTruthy();
    expect(screen.getByRole("link", { name: "CSV" }).getAttribute("href")).toBe(
      `/api/repositories/${repositoryId}/coverage/files/export?slice=idinspect&metric=branches&format=csv`
    );

    await userEvent.selectOptions(screen.getByRole("combobox"), "apps/rpm-api");
    expect(screen.queryByText("InspectionInstanceController.getInspection")).toBeNull();
    expect(screen.getByText("login")).toBeTruthy();
    await userEvent.selectOptions(screen.getByRole("combobox"), "");
    await userEvent.type(screen.getByPlaceholderText(/Filter by path/), "work");
    expect(screen.queryByText("InspectionInstanceController.getInspection")).toBeNull();
    expect(screen.getByText("WorkOrderController.createWorkOrder")).toBeTruthy();
    expect(requests.calls.some((call) => call.url.includes("/coverage/files?slice=idinspect&metric=branches"))).toBe(true);
  });
});

describe("pizza wedge", () => {
  it("draws nothing at zero, a half with the small arc, and a full circle at 100%", () => {
    expect(wedgePath(50, 50, 40, 0)).toBeNull();
    expect(wedgePath(50, 50, 40, 50)).toContain("A 40 40 0 0 1");
    expect(wedgePath(50, 50, 40, 75)).toContain("A 40 40 0 1 1");
    expect(wedgePath(50, 50, 40, 100)).not.toContain("L");
  });
});

describe("file gaps", () => {
  it("shows a file's uncovered functions, lines, and branches when expanded", async () => {
    const detail: SliceDetail = { ...slice, endpoints: [], unmatchedCalls: [] };
    const fileMetric = metric(3, 10);
    const requests = stubFetch(
      { config, builds: [], slices: [slice] },
      {
        "/slices/idinspect": { slice: detail },
        "/coverage/files": {
          files: [{ appName: "@acme/api", path: "apps/api/src/users.service.ts", lines: fileMetric, statements: fileMetric, functions: fileMetric, branches: fileMetric }],
          total: 1,
          limit: 15,
          offset: 0
        },
        "/coverage/file": {
          file: {
            appName: "@acme/api",
            path: "apps/api/src/users.service.ts",
            lines: fileMetric,
            statements: fileMetric,
            functions: fileMetric,
            branches: fileMetric,
            details: {
              uncoveredLines: [[12, 18], [40, 40]],
              uncoveredFunctions: [{ name: "removeUser", line: 12 }],
              uncoveredBranches: [{ line: 30, type: "if", uncovered: 1, total: 2 }]
            },
            snapshot: { runId: "run-1", resolvedSha: "abc", capturedAt: "2026-11-04T11:00:00.000Z" }
          }
        }
      }
    );
    renderAt(`/repositories/${repositoryId}/slices/idinspect`);

    await userEvent.click(await screen.findByRole("button", { name: "Show gaps" }));
    expect(await screen.findByText("12-18, 40")).toBeTruthy();
    expect(screen.getByText(/removeUser/)).toBeTruthy();
    expect(screen.getByText(/1 of 2 paths missed/)).toBeTruthy();
    expect(requests.calls.some((call) => call.url.endsWith("/coverage/file?path=apps%2Fapi%2Fsrc%2Fusers.service.ts"))).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Hide gaps" }));
    expect(screen.queryByText("12-18, 40")).toBeNull();
  });
});
