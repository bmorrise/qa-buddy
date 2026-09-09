import type { CoverageMetric, CoverageSummary } from "./types.js";

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

export function parseIstanbulSummary(contents: string): CoverageSummary {
  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch {
    throw new Error("Coverage summary is not valid JSON");
  }

  if (!document || typeof document !== "object" || !("total" in document)) {
    throw new Error("Coverage summary must contain a total object");
  }

  const total = (document as { total: Record<string, unknown> }).total;
  return {
    lines: parseIstanbulMetric(total.lines, "lines"),
    statements: parseIstanbulMetric(total.statements, "statements"),
    functions: parseIstanbulMetric(total.functions, "functions"),
    branches: parseIstanbulMetric(total.branches, "branches")
  };
}

export function parseLcov(contents: string): CoverageSummary {
  let linesFound = 0;
  let linesHit = 0;
  let functionsFound = 0;
  let functionsHit = 0;
  let branchesFound = 0;
  let branchesHit = 0;
  let records = 0;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "end_of_record") {
      records += 1;
    } else if (line.startsWith("DA:")) {
      linesFound += 1;
      const hits = Number(line.slice(3).split(",")[1]);
      if (Number.isFinite(hits) && hits > 0) linesHit += 1;
    } else if (line.startsWith("FNDA:")) {
      functionsFound += 1;
      const hits = Number(line.slice(5).split(",")[0]);
      if (Number.isFinite(hits) && hits > 0) functionsHit += 1;
    } else if (line.startsWith("BRDA:")) {
      branchesFound += 1;
      const hits = line.slice(5).split(",")[3];
      if (hits && hits !== "-" && Number(hits) > 0) branchesHit += 1;
    }
  }

  if (records === 0 && linesFound === 0 && functionsFound === 0 && branchesFound === 0) {
    throw new Error("LCOV report does not contain any coverage records");
  }

  return {
    lines: metric(linesHit, linesFound),
    statements: null,
    functions: metric(functionsHit, functionsFound),
    branches: metric(branchesHit, branchesFound)
  };
}
