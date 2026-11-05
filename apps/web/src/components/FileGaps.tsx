import { Fragment, useEffect, useState, type ReactNode } from "react";
import { formatLineRanges, type CoverageFileDetail } from "@qa-buddy/shared";
import { api } from "../api";

/** The uncovered functions, lines, and branches of one file, fetched when shown. */
export function FileGaps({ repositoryId, path }: { repositoryId: string; path: string }) {
  const [file, setFile] = useState<CoverageFileDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api<{ file: CoverageFileDetail }>(`/api/repositories/${repositoryId}/coverage/file?${new URLSearchParams({ path }).toString()}`)
      .then((response) => !cancelled && setFile(response.file))
      .catch((caught: Error) => !cancelled && setError(caught.message));
    return () => {
      cancelled = true;
    };
  }, [repositoryId, path]);

  if (error) return <p className="inline-error file-gaps-message">{error}</p>;
  if (!file) return <p className="muted file-gaps-message">Loading gaps…</p>;
  if (!file.details) {
    return (
      <p className="muted file-gaps-message">
        No gap details yet. They are recorded from the next run that tests this app with a detailed coverage report.
      </p>
    );
  }
  const { uncoveredFunctions, uncoveredLines, uncoveredBranches } = file.details;
  if (!uncoveredFunctions.length && !uncoveredLines.length && !uncoveredBranches.length) {
    return <p className="muted file-gaps-message">Every line, function, and branch in this file ran.</p>;
  }
  return (
    <dl className="file-gaps">
      <div>
        <dt>Functions never called</dt>
        <dd>
          {uncoveredFunctions.length
            ? uncoveredFunctions.map((fn) => <code key={`${fn.name}:${fn.line}`}>{fn.name} <small>line {fn.line}</small></code>)
            : <span className="muted">None</span>}
        </dd>
      </div>
      <div>
        <dt>Lines never run</dt>
        <dd>{uncoveredLines.length ? <code>{formatLineRanges(uncoveredLines)}</code> : <span className="muted">None</span>}</dd>
      </div>
      <div>
        <dt>Branches partly taken</dt>
        <dd>
          {uncoveredBranches.length
            ? uncoveredBranches.map((branch) => (
                <code key={`${branch.line}:${branch.type}`}>
                  line {branch.line} <small>{branch.type}, {branch.uncovered} of {branch.total} paths missed</small>
                </code>
              ))
            : <span className="muted">None</span>}
        </dd>
      </div>
    </dl>
  );
}

/**
 * A table row with a "Show gaps" toggle in its file cell and an expanding
 * detail row beneath it.
 */
export function FileRowWithGaps({
  repositoryId,
  path,
  columnCount,
  children
}: {
  repositoryId: string;
  path: string;
  columnCount: number;
  /** Cells after the file cell. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Fragment>
      <tr className={open ? "file-row-open" : undefined}>
        <td>
          <code className="gap-path">{path}</code>
          <button type="button" className="text-button file-gaps-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide gaps" : "Show gaps"}
          </button>
        </td>
        {children}
      </tr>
      {open && (
        <tr className="file-gaps-row">
          <td colSpan={columnCount}>
            <FileGaps repositoryId={repositoryId} path={path} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}
