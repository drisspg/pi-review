import type { DiffRow, DragSelection, Target } from "../types";

export function parsePatchRows(patch: string | undefined): DiffRow[] {
  if (patch == null) return [];
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let currentHunk = "";
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk != null) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[2], 10);
      currentHunk = line;
      rows.push({ kind: "hunk", oldLine: null, newLine: null, text: line, hunk: currentHunk });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "added", oldLine: null, newLine, text: line, hunk: currentHunk });
      newLine += 1;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "removed", oldLine, newLine: null, text: line, hunk: currentHunk });
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "context", oldLine, newLine, text: line, hunk: currentHunk });
      oldLine += 1;
      newLine += 1;
    } else {
      rows.push({ kind: "meta", oldLine: null, newLine: null, text: line, hunk: currentHunk });
    }
  }
  return rows;
}

export function contextRowsFromText(fileText: string | undefined, startLine: number, endLine: number): DiffRow[] {
  if (fileText == null || endLine < startLine) return [];
  const lines = fileText.split("\n");
  const rows: DiffRow[] = [];
  for (let line = Math.max(1, startLine); line <= Math.min(endLine, lines.length); line += 1) {
    rows.push({ kind: "context expanded-context", oldLine: line, newLine: line, text: ` ${lines[line - 1] ?? ""}`, hunk: "" });
  }
  return rows;
}

export function hunkNewStart(row: DiffRow): number | null {
  const match = row.text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  return match == null ? null : Number.parseInt(match[1], 10);
}

export function lastNewLine(rows: DiffRow[]): number | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].newLine != null) return rows[index].newLine;
  }
  return null;
}

export function isTargetInSelection(target: Target | null, selection: DragSelection | null): boolean {
  if (target == null || selection == null || target.line == null || selection.start.line == null || selection.current.line == null) return false;
  if (target.path !== selection.start.path || target.side !== selection.start.side) return false;
  const start = Math.min(selection.start.line, selection.current.line);
  const end = Math.max(selection.start.line, selection.current.line);
  return target.line >= start && target.line <= end;
}

export function targetFromRow(row: HTMLElement | null): Target | null {
  if (row == null) return null;
  const line = Number.parseInt(row.dataset.line ?? "", 10);
  const path = row.dataset.path;
  const side = row.dataset.side;
  if (path == null || !Number.isInteger(line) || (side !== "RIGHT" && side !== "LEFT")) return null;
  return { path, line, side, hunk: row.dataset.hunk ?? "" };
}

export function targetFromPoint(clientX: number, clientY: number): Target | null {
  return targetFromRow(document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".diff-row[data-path]") ?? null);
}
