import type { CoverageFileDetails, CoverageFileEntry, CoverageMetric, CoverageReport, CoverageSummary } from "./types.js";

function metric(covered: number, total: number): CoverageMetric {
  return {
    covered,
    total,
    percent: total === 0 ? null : Math.round((covered / total) * 1_000) / 10
  };
}

interface IstanbulMetric {
  covered?: unknown;
  total?: unknown;
}

function parseIstanbulMetric(value: unknown, name: string): CoverageMetric {
  if (!value || typeof value !== "object") {
    throw new Error(`Coverage summary is missing ${name}`);
  }

  const candidate = value as IstanbulMetric;
  if (
    typeof candidate.covered !== "number" ||
    typeof candidate.total !== "number" ||
    candidate.covered < 0 ||
    candidate.total < 0 ||
    candidate.covered > candidate.total
  ) {
    throw new Error(`Coverage summary has invalid ${name} counts`);
  }

  return metric(candidate.covered, candidate.total);
}


function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

/**
 * Coverage reporters emit absolute container paths such as
 * `/workspaces/<runId>/repo/apps/web/src/x.ts`, which contain the run id and so
 * never match between runs. Everything is reduced to a repository-root-relative
 * POSIX path so snapshots stay comparable.
 */
export function normalizeCoverageFilePath(
  value: string,
  options: { rootDirectory?: string; workingDirectory?: string } = {}
): string {
  let candidate = toPosix(value.trim());
  if (candidate.startsWith("file://")) candidate = candidate.slice("file://".length);

  const root = options.rootDirectory ? toPosix(options.rootDirectory).replace(/\/+$/, "") : "";
  if (root && (candidate === root || candidate.startsWith(`${root}/`))) {
    return candidate.slice(root.length + 1);
  }
  if (candidate.startsWith("/")) {
    // Outside the checkout entirely; keep only the basename so nothing leaks a host path.
    return candidate.slice(candidate.lastIndexOf("/") + 1);
  }

  candidate = candidate.replace(/^\.\//, "");
  const workingDirectory = options.workingDirectory
    ? toPosix(options.workingDirectory).replace(/^\.\//, "").replace(/\/+$/, "")
    : "";
  if (workingDirectory && workingDirectory !== "." && !candidate.startsWith(`${workingDirectory}/`)) {
    return `${workingDirectory}/${candidate}`;
  }
  return candidate;
}

export interface CoverageParseOptions {
  rootDirectory?: string;
  workingDirectory?: string;
}

function optionalIstanbulMetric(value: unknown): CoverageMetric | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as IstanbulMetric;
  if (
    typeof candidate.covered !== "number" ||
    typeof candidate.total !== "number" ||
    candidate.covered < 0 ||
    candidate.total < 0 ||
    candidate.covered > candidate.total
  ) {
    return null;
  }
  return metric(candidate.covered, candidate.total);
}

function sortFiles(files: CoverageFileEntry[]): CoverageFileEntry[] {
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function parseIstanbulReport(
  contents: string,
  options: CoverageParseOptions = {}
): CoverageReport {
  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch {
    throw new Error("Coverage summary is not valid JSON");
  }

  if (!document || typeof document !== "object" || !("total" in document)) {
    throw new Error("Coverage summary must contain a total object");
  }

  const entries = document as Record<string, unknown>;
  const total = (entries as { total: Record<string, unknown> }).total;
  const summary: CoverageSummary = {
    lines: parseIstanbulMetric(total.lines, "lines"),
    statements: parseIstanbulMetric(total.statements, "statements"),
    functions: parseIstanbulMetric(total.functions, "functions"),
    branches: parseIstanbulMetric(total.branches, "branches")
  };

  const files: CoverageFileEntry[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (key === "total" || !value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const entry: CoverageFileEntry = {
      path: normalizeCoverageFilePath(key, options),
      lines: optionalIstanbulMetric(record.lines),
      statements: optionalIstanbulMetric(record.statements),
      functions: optionalIstanbulMetric(record.functions),
      branches: optionalIstanbulMetric(record.branches)
    };
    // A file entry with no usable metric tells us nothing; skipping keeps a
    // malformed record from failing a run that produced a valid total.
    if (entry.path && (entry.lines || entry.statements || entry.functions || entry.branches)) {
      files.push(entry);
    }
  }

  return { summary, files: sortFiles(files) };
}

export function parseIstanbulSummary(contents: string): CoverageSummary {
  return parseIstanbulReport(contents).summary;
}

export function parseLcovReport(contents: string, options: CoverageParseOptions = {}): CoverageReport {
  let linesFound = 0;
  let linesHit = 0;
  let functionsFound = 0;
  let functionsHit = 0;
  let branchesFound = 0;
  let branchesHit = 0;
  let records = 0;

  const files: CoverageFileEntry[] = [];
  let current: { path: string; lf: number; lh: number; fnf: number; fnh: number; brf: number; brh: number } | null = null;

  const closeRecord = (): void => {
    if (!current) return;
    if (current.path) {
      files.push({
        path: current.path,
        lines: metric(current.lh, current.lf),
        // LCOV has no separate statement metric, so it stays N/A per file too.
        statements: null,
        functions: metric(current.fnh, current.fnf),
        branches: metric(current.brh, current.brf)
      });
    }
    current = null;
  };

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      closeRecord();
      current = {
        path: normalizeCoverageFilePath(line.slice(3), options),
        lf: 0,
        lh: 0,
        fnf: 0,
        fnh: 0,
        brf: 0,
        brh: 0
      };
    } else if (line === "end_of_record") {
      records += 1;
      closeRecord();
    } else if (line.startsWith("DA:")) {
      linesFound += 1;
      const hits = Number(line.slice(3).split(",")[1]);
      const covered = Number.isFinite(hits) && hits > 0;
      if (covered) linesHit += 1;
      if (current) {
        current.lf += 1;
        if (covered) current.lh += 1;
      }
    } else if (line.startsWith("FNDA:")) {
      functionsFound += 1;
      const hits = Number(line.slice(5).split(",")[0]);
      const covered = Number.isFinite(hits) && hits > 0;
      if (covered) functionsHit += 1;
      if (current) {
        current.fnf += 1;
        if (covered) current.fnh += 1;
      }
    } else if (line.startsWith("BRDA:")) {
      branchesFound += 1;
      const hits = line.slice(5).split(",")[3];
      const covered = Boolean(hits && hits !== "-" && Number(hits) > 0);
      if (covered) branchesHit += 1;
      if (current) {
        current.brf += 1;
        if (covered) current.brh += 1;
      }
    }
  }
  // Tolerate a final record that never emitted end_of_record.
  closeRecord();

  if (records === 0 && linesFound === 0 && functionsFound === 0 && branchesFound === 0) {
    throw new Error("LCOV report does not contain any coverage records");
  }

  return {
    summary: {
      lines: metric(linesHit, linesFound),
      statements: null,
      functions: metric(functionsHit, functionsFound),
      branches: metric(branchesHit, branchesFound)
    },
    files: sortFiles(files)
  };
}

export function parseLcov(contents: string): CoverageSummary {
  return parseLcovReport(contents).summary;
}

/** Per-file caps so one enormous file cannot bloat the snapshot. */
export const COVERAGE_DETAIL_LIMITS = { lineRanges: 400, functions: 300, branches: 400 } as const;

/** Collapses line numbers into sorted, inclusive ranges. */
export function toLineRanges(lines: Iterable<number>): Array<[number, number]> {
  const sorted = Array.from(new Set(lines)).filter((line) => Number.isInteger(line) && line > 0).sort((left, right) => left - right);
  const ranges: Array<[number, number]> = [];
  for (const line of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && line === last[1] + 1) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges;
}

/** `12-18, 40` style text for line ranges. */
export function formatLineRanges(ranges: Array<[number, number]>): string {
  return ranges.map(([start, end]) => (start === end ? String(start) : `${start}-${end}`)).join(", ");
}

function capDetails(details: CoverageFileDetails): CoverageFileDetails {
  return {
    uncoveredLines: details.uncoveredLines.slice(0, COVERAGE_DETAIL_LIMITS.lineRanges),
    uncoveredFunctions: details.uncoveredFunctions.slice(0, COVERAGE_DETAIL_LIMITS.functions),
    uncoveredBranches: details.uncoveredBranches.slice(0, COVERAGE_DETAIL_LIMITS.branches)
  };
}

interface IstanbulLocation {
  start?: { line?: unknown };
}

const startLine = (location: unknown): number | null => {
  const line = (location as IstanbulLocation | undefined)?.start?.line;
  return typeof line === "number" && Number.isInteger(line) && line > 0 ? line : null;
};

/**
 * Reads gap locations from Istanbul's detailed report (`coverage-final.json`),
 * keyed by normalized file path. A line counts as uncovered when statements
 * start on it and none of them ran, matching Istanbul's own line metric.
 */
export function parseIstanbulDetails(
  contents: string,
  options: CoverageParseOptions = {}
): Map<string, CoverageFileDetails> {
  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch {
    throw new Error("Detailed coverage report is not valid JSON");
  }
  const result = new Map<string, CoverageFileDetails>();
  if (!document || typeof document !== "object") return result;

  for (const [key, value] of Object.entries(document as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const filePath = normalizeCoverageFilePath(typeof record.path === "string" ? record.path : key, options);
    if (!filePath) continue;

    const statementMap = (record.statementMap ?? {}) as Record<string, unknown>;
    const statementHits = (record.s ?? {}) as Record<string, unknown>;
    const coveredLines = new Set<number>();
    const missedLines = new Set<number>();
    for (const [id, location] of Object.entries(statementMap)) {
      const line = startLine(location);
      if (line === null) continue;
      if (Number(statementHits[id]) > 0) coveredLines.add(line);
      else missedLines.add(line);
    }

    const fnMap = (record.fnMap ?? {}) as Record<string, { name?: unknown; decl?: unknown; loc?: unknown; line?: unknown }>;
    const fnHits = (record.f ?? {}) as Record<string, unknown>;
    const uncoveredFunctions = Object.entries(fnMap)
      .filter(([id]) => !(Number(fnHits[id]) > 0))
      .map(([, fn]) => ({
        name: typeof fn.name === "string" && fn.name ? fn.name : "(anonymous)",
        line: startLine(fn.decl) ?? startLine(fn.loc) ?? (typeof fn.line === "number" ? fn.line : 0)
      }))
      .sort((left, right) => left.line - right.line);

    const branchMap = (record.branchMap ?? {}) as Record<string, { type?: unknown; loc?: unknown; line?: unknown; locations?: unknown }>;
    const branchHits = (record.b ?? {}) as Record<string, unknown>;
    const uncoveredBranches = Object.entries(branchMap)
      .flatMap(([id, branch]) => {
        const counts = Array.isArray(branchHits[id]) ? (branchHits[id] as unknown[]).map(Number) : [];
        const uncovered = counts.filter((count) => !(count > 0)).length;
        if (counts.length === 0 || uncovered === 0) return [];
        const line = startLine(branch.loc) ?? (typeof branch.line === "number" ? branch.line : 0);
        return [{ line, type: typeof branch.type === "string" ? branch.type : "branch", uncovered, total: counts.length }];
      })
      .sort((left, right) => left.line - right.line);

    result.set(
      filePath,
      capDetails({
        uncoveredLines: toLineRanges(Array.from(missedLines).filter((line) => !coveredLines.has(line))),
        uncoveredFunctions,
        uncoveredBranches
      })
    );
  }
  return result;
}

/** Reads gap locations from an LCOV report, keyed by normalized file path. */
export function parseLcovDetails(contents: string, options: CoverageParseOptions = {}): Map<string, CoverageFileDetails> {
  const result = new Map<string, CoverageFileDetails>();
  let current: {
    path: string;
    missed: number[];
    functionLines: Map<string, number>;
    functionHits: Map<string, number>;
    branches: Map<string, { line: number; total: number; uncovered: number }>;
  } | null = null;

  const close = (): void => {
    if (!current?.path) {
      current = null;
      return;
    }
    const { functionLines, functionHits } = current;
    result.set(
      current.path,
      capDetails({
        uncoveredLines: toLineRanges(current.missed),
        uncoveredFunctions: Array.from(functionLines.entries())
          .filter(([name]) => !((functionHits.get(name) ?? 0) > 0))
          .map(([name, line]) => ({ name, line }))
          .sort((left, right) => left.line - right.line),
        uncoveredBranches: Array.from(current.branches.values())
          .filter((branch) => branch.uncovered > 0)
          .map((branch) => ({ line: branch.line, type: "branch", uncovered: branch.uncovered, total: branch.total }))
          .sort((left, right) => left.line - right.line)
      })
    );
    current = null;
  };

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      close();
      current = {
        path: normalizeCoverageFilePath(line.slice(3), options),
        missed: [],
        functionLines: new Map(),
        functionHits: new Map(),
        branches: new Map()
      };
    } else if (line === "end_of_record") {
      close();
    } else if (!current) {
      continue;
    } else if (line.startsWith("DA:")) {
      const [lineNumber, hits] = line.slice(3).split(",").map(Number);
      if (lineNumber && !(hits! > 0)) current.missed.push(lineNumber);
    } else if (line.startsWith("FN:")) {
      const [lineNumber, ...name] = line.slice(3).split(",");
      current.functionLines.set(name.join(","), Number(lineNumber));
    } else if (line.startsWith("FNDA:")) {
      const [hits, ...name] = line.slice(5).split(",");
      current.functionHits.set(name.join(","), Number(hits));
    } else if (line.startsWith("BRDA:")) {
      const [lineNumber, block, , hits] = line.slice(5).split(",");
      const key = `${lineNumber}:${block}`;
      const branch = current.branches.get(key) ?? { line: Number(lineNumber), total: 0, uncovered: 0 };
      branch.total += 1;
      if (!hits || hits === "-" || !(Number(hits) > 0)) branch.uncovered += 1;
      current.branches.set(key, branch);
    }
  }
  close();
  return result;
}
