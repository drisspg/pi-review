import type { DiffRow, DragSelection, Target } from "../types";

export type PatchSetSection = {
  title: string;
  rows: DiffRow[];
};

function diffRowWithSyntax(row: DiffRow, tripleString: string | null): DiffRow {
  return tripleString == null ? row : { ...row, syntaxContext: "string" };
}

function nextPythonTripleString(line: string, active: string | null): string | null {
  let index = 0;
  let current = active;
  for (;;) {
    const tripleDouble = line.indexOf('"""', index);
    const tripleSingle = line.indexOf("'''", index);
    const nextIndex = [tripleDouble, tripleSingle].filter((value) => value >= 0).sort((left, right) => left - right)[0];
    if (nextIndex == null) return current;
    const token = nextIndex === tripleDouble ? '"""' : "'''";
    if (nextIndex > 0 && line[nextIndex - 1] === "\\") {
      index = nextIndex + token.length;
      continue;
    }
    if (current == null) current = token;
    else if (current === token) current = null;
    index = nextIndex + token.length;
  }
}

export function parsePatchRows(patch: string | undefined): DiffRow[] {
  if (patch == null) return [];
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let currentHunk = "";
  let oldTripleString: string | null = null;
  let newTripleString: string | null = null;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk != null) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[2], 10);
      currentHunk = line;
      oldTripleString = null;
      newTripleString = null;
      rows.push({ kind: "hunk", oldLine: null, newLine: null, text: line, hunk: currentHunk });
    } else if (line.startsWith("+")) {
      const row = diffRowWithSyntax({ kind: "added", oldLine: null, newLine, text: line, hunk: currentHunk }, newTripleString);
      newTripleString = nextPythonTripleString(line.slice(1), newTripleString);
      rows.push(row);
      newLine += 1;
    } else if (line.startsWith("-")) {
      const row = diffRowWithSyntax({ kind: "removed", oldLine, newLine: null, text: line, hunk: currentHunk }, oldTripleString);
      oldTripleString = nextPythonTripleString(line.slice(1), oldTripleString);
      rows.push(row);
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      const row = diffRowWithSyntax({ kind: "context", oldLine, newLine, text: line, hunk: currentHunk }, oldTripleString ?? newTripleString);
      oldTripleString = nextPythonTripleString(line.slice(1), oldTripleString);
      newTripleString = nextPythonTripleString(line.slice(1), newTripleString);
      rows.push(row);
      oldLine += 1;
      newLine += 1;
    } else {
      rows.push({ kind: "meta", oldLine: null, newLine: null, text: line, hunk: currentHunk });
    }
  }
  return rows;
}

export function parsePatchSetSections(patch: string | undefined): PatchSetSection[] {
  const contentRows = parsePatchRows(patch).filter((row) => row.newLine != null && ["added", "context"].includes(row.kind));
  const sections: PatchSetSection[] = [];
  let current: PatchSetSection | null = null;
  let currentHunk = "";
  let sawInnerDiff = false;

  for (const row of contentRows) {
    const text = row.text.slice(1);
    const diffTitle = patchSetDiffTitle(text);
    if (diffTitle != null) {
      current = { title: diffTitle, rows: [] };
      sections.push(current);
      currentHunk = "";
      sawInnerDiff = true;
    } else if (current == null) {
      current = { title: "Patch overview", rows: [] };
      sections.push(current);
    }

    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (hunk != null) currentHunk = text;
    current.rows.push({ ...row, kind: patchSetRowKind(text), oldLine: null, text, hunk: currentHunk });
  }

  return sawInnerDiff ? sections : [];
}

function patchSetDiffTitle(text: string): string | null {
  const match = text.match(/^diff --git a\/(.+?) b\/(.+)$/);
  return match == null ? null : match[2];
}

function patchSetRowKind(text: string): string {
  if (text.match(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/) != null) return "hunk patchset-hunk";
  if (text.startsWith("--- ") || text.startsWith("+++ ")) return "meta patchset-meta";
  if (text.startsWith("+")) return "added";
  if (text.startsWith("-")) return "removed";
  if (text.startsWith(" ")) return "context";
  return "meta patchset-meta";
}

export function contextRowsFromText(fileText: string | undefined, startLine: number, endLine: number): DiffRow[] {
  if (fileText == null || endLine < startLine) return [];
  const lines = fileText.split("\n");
  const rows: DiffRow[] = [];
  let tripleString: string | null = null;
  for (let line = 1; line <= Math.min(endLine, lines.length); line += 1) {
    const rowText = ` ${lines[line - 1] ?? ""}`;
    if (line >= Math.max(1, startLine)) rows.push(diffRowWithSyntax({ kind: "context expanded-context", oldLine: line, newLine: line, text: rowText, hunk: "" }, tripleString));
    tripleString = nextPythonTripleString(lines[line - 1] ?? "", tripleString);
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
