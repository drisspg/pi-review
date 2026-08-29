/**
 * Typed schematic contract for the overview's fenced ```schematic blocks.
 *
 * The overview prompt asks the model for this JSON instead of Mermaid text so
 * rendering quality is owned by the app (React Flow + ELK) rather than by the
 * model's diagram syntax. Parsing is strict about structure (ids, references)
 * but lenient about enums: unknown kinds fall back to defaults so a slightly
 * off answer still renders instead of collapsing to raw JSON.
 */

export type SchematicNodeKind = "entry" | "core" | "state" | "boundary" | "test";
export type SchematicEdgeKind = "call" | "data" | "state";
export type SchematicDirection = "right" | "down";

export type SchematicGroup = { id: string; label: string };
export type SchematicNode = { id: string; label: string; detail?: string; ref?: string; kind: SchematicNodeKind; group?: string };
export type SchematicEdge = { from: string; to: string; label?: string; kind: SchematicEdgeKind };

export type Schematic = {
  title?: string;
  direction: SchematicDirection;
  groups: SchematicGroup[];
  nodes: SchematicNode[];
  edges: SchematicEdge[];
};

const NODE_KINDS: readonly SchematicNodeKind[] = ["entry", "core", "state", "boundary", "test"];
const EDGE_KINDS: readonly SchematicEdgeKind[] = ["call", "data", "state"];

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value == null || Array.isArray(value)) throw new Error(`Expected ${context} to be an object`);
  return value as Record<string, unknown>;
}

function asRecordArray(value: unknown, context: string): Record<string, unknown>[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`Expected ${context} to be an array`);
  return value.map((item, index) => asRecord(item, `${context}[${index}]`));
}

function requiredText(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Expected ${context}.${key} to be non-empty text`);
  return value.trim();
}

function optionalText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Parse one fenced ```schematic block; throws with a message worth showing in the error card. */
export function parseSchematic(code: string): Schematic {
  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch (err) {
    throw new Error(`Schematic is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const root = asRecord(raw, "schematic");

  const groups: SchematicGroup[] = [];
  const groupIds = new Set<string>();
  for (const [index, record] of asRecordArray(root.groups, "groups").entries()) {
    const group = { id: requiredText(record, "id", `groups[${index}]`), label: requiredText(record, "label", `groups[${index}]`) };
    if (groupIds.has(group.id)) throw new Error(`Duplicate group id "${group.id}"`);
    groupIds.add(group.id);
    groups.push(group);
  }

  const nodeRecords = asRecordArray(root.nodes, "nodes");
  if (nodeRecords.length === 0) throw new Error("Schematic has no nodes");
  const nodes: SchematicNode[] = [];
  const nodeIds = new Set<string>();
  for (const [index, record] of nodeRecords.entries()) {
    const id = requiredText(record, "id", `nodes[${index}]`);
    if (nodeIds.has(id)) throw new Error(`Duplicate node id "${id}"`);
    nodeIds.add(id);
    const kind = record.kind;
    const group = optionalText(record, "group");
    nodes.push({
      id,
      label: requiredText(record, "label", `nodes[${index}]`),
      detail: optionalText(record, "detail"),
      ref: optionalText(record, "ref"),
      kind: NODE_KINDS.includes(kind as SchematicNodeKind) ? (kind as SchematicNodeKind) : "core",
      group: group != null && groupIds.has(group) ? group : undefined,
    });
  }

  // Drop edges with unknown endpoints instead of failing: one hallucinated id
  // should not blank out an otherwise useful diagram.
  const edges: SchematicEdge[] = [];
  for (const record of asRecordArray(root.edges, "edges")) {
    const from = optionalText(record, "from");
    const to = optionalText(record, "to");
    if (from == null || to == null || !nodeIds.has(from) || !nodeIds.has(to)) continue;
    const kind = record.kind;
    edges.push({
      from,
      to,
      label: optionalText(record, "label"),
      kind: EDGE_KINDS.includes(kind as SchematicEdgeKind) ? (kind as SchematicEdgeKind) : "call",
    });
  }

  return {
    title: optionalText(root, "title"),
    direction: root.direction === "down" ? "down" : "right",
    groups: groups.filter((group) => nodes.some((node) => node.group === group.id)),
    nodes,
    edges,
  };
}
