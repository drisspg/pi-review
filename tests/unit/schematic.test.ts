import assert from "node:assert/strict";
import test from "node:test";

import { parseSchematic } from "../../web/src/lib/schematic.js";

test("parses a full schematic block", () => {
  const schematic = parseSchematic(JSON.stringify({
    title: "Execution path",
    direction: "down",
    groups: [{ id: "wiring", label: "CP wiring" }],
    nodes: [
      { id: "apply_cp", label: "apply_cp()", detail: "selects the MLA path", ref: "models/parallelize.py:105", kind: "entry", group: "wiring" },
      { id: "forward", label: "Model.forward", kind: "core" },
    ],
    edges: [{ from: "apply_cp", to: "forward", label: "wires", kind: "data" }],
  }));

  assert.equal(schematic.title, "Execution path");
  assert.equal(schematic.direction, "down");
  assert.deepEqual(schematic.groups, [{ id: "wiring", label: "CP wiring" }]);
  assert.equal(schematic.nodes[0]?.ref, "models/parallelize.py:105");
  assert.equal(schematic.nodes[0]?.group, "wiring");
  assert.deepEqual(schematic.edges, [{ from: "apply_cp", to: "forward", label: "wires", kind: "data" }]);
});

test("coerces unknown kinds and directions to defaults", () => {
  const schematic = parseSchematic(JSON.stringify({
    direction: "diagonal",
    nodes: [{ id: "a", label: "A", kind: "mystery" }, { id: "b", label: "B" }],
    edges: [{ from: "a", to: "b", kind: "telepathy" }],
  }));

  assert.equal(schematic.direction, "right");
  assert.equal(schematic.nodes[0]?.kind, "core");
  assert.equal(schematic.edges[0]?.kind, "call");
});

test("drops dangling edges, unknown group refs, and empty groups", () => {
  const schematic = parseSchematic(JSON.stringify({
    groups: [{ id: "empty", label: "Nobody home" }],
    nodes: [{ id: "a", label: "A", group: "ghost" }, { id: "b", label: "B" }],
    edges: [{ from: "a", to: "b" }, { from: "a", to: "missing" }, { from: "a" }],
  }));

  assert.deepEqual(schematic.groups, []);
  assert.equal(schematic.nodes[0]?.group, undefined);
  assert.equal(schematic.edges.length, 1);
});

test("rejects structurally broken schematics", () => {
  assert.throws(() => parseSchematic("not json"), /not valid JSON/);
  assert.throws(() => parseSchematic("{}"), /no nodes/);
  assert.throws(() => parseSchematic('{"nodes": [{"id": "a", "label": "A"}, {"id": "a", "label": "B"}]}'), /Duplicate node id/);
  assert.throws(() => parseSchematic('{"nodes": [{"id": "a"}]}'), /nodes\[0\]\.label/);
});
