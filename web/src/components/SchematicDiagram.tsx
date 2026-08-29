/**
 * Renders a fenced ```schematic JSON block as an interactive React Flow canvas.
 *
 * Nodes are DOM cards (crisp at any zoom, styled by the app's design tokens)
 * laid out by ELK after a hidden measurement pass, and cards with a file:line
 * ref open that location like the markdown file-reference links do.
 */
import "@xyflow/react/dist/style.css";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { errorMessage, openFileInEditor } from "../api";
import { cssVar } from "../lib/dom";import { parseSchematic, type Schematic, type SchematicDirection, type SchematicNodeKind } from "../lib/schematic";
import type { FileLinkContext } from "./MarkdownContext";

type CardData = { label: string; detail?: string; refText?: string; kind: SchematicNodeKind; direction: SchematicDirection };
type CardNode = Node<CardData, "card">;
type FrameNode = Node<{ label: string }, "frame">;

function SchematicCard({ data }: NodeProps<CardNode>) {
  const horizontal = data.direction === "right";
  return <div className={`schematic-card schematic-kind-${data.kind}${data.refText == null ? "" : " has-ref"}`} title={data.refText == null ? undefined : "Open in VS Code"}>
    <Handle type="target" position={horizontal ? Position.Left : Position.Top} className="schematic-handle" isConnectable={false} />
    <span className="schematic-card-label">{data.label}</span>
    {data.detail != null && <span className="schematic-card-detail">{data.detail}</span>}
    {data.refText != null && <span className="schematic-card-ref">{data.refText}</span>}
    <Handle type="source" position={horizontal ? Position.Right : Position.Bottom} className="schematic-handle" isConnectable={false} />
  </div>;
}

function SchematicFrame({ data }: NodeProps<FrameNode>) {
  return <div className="schematic-frame"><span className="schematic-frame-label">{data.label}</span></div>;
}

const nodeTypes = { card: SchematicCard, frame: SchematicFrame };

function flowNodes(schematic: Schematic): Node[] {
  // Group frames must precede their children: React Flow resolves parentId
  // against nodes already seen in the array.
  const frames: Node[] = schematic.groups.map((group) => ({
    id: group.id,
    type: "frame",
    position: { x: 0, y: 0 },
    data: { label: group.label },
    draggable: false,
    selectable: false,
    zIndex: -1,
  }));
  const cards: Node[] = schematic.nodes.map((node) => ({
    id: node.id,
    type: "card",
    position: { x: 0, y: 0 },
    parentId: node.group,
    data: { label: node.label, detail: node.detail, refText: node.ref, kind: node.kind, direction: schematic.direction },
  }));
  return [...frames, ...cards];
}

function flowEdges(schematic: Schematic): Edge[] {
  const markerColor = cssVar("--muted", "#8b949e");
  return schematic.edges.map((edge, index) => ({
    id: `edge-${index}`,
    source: edge.from,
    target: edge.to,
    label: edge.label,
    type: "smoothstep",
    className: `schematic-edge-${edge.kind}`,
    markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: markerColor },
  }));
}

const elk = new ELK();

type Placement = { x: number; y: number; width?: number; height?: number };
type ElkLayout = { placements: Map<string, Placement>; contentHeight: number };

/** ELK layered layout over the measured node sizes; group coordinates stay parent-relative like React Flow wants. */
async function elkPlacements(schematic: Schematic, measured: Node[]): Promise<ElkLayout> {
  const size = new Map(measured.map((node) => [node.id, { width: node.measured?.width ?? 200, height: node.measured?.height ?? 56 }]));
  const leaf = (id: string) => ({ id, ...size.get(id) });
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": schematic.direction === "down" ? "DOWN" : "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "64",
      "elk.spacing.nodeNode": "28",
      "elk.spacing.edgeNode": "28",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    },
    children: [
      ...schematic.groups.map((group) => ({
        id: group.id,
        // Top padding reserves room for the frame label.
        layoutOptions: { "elk.padding": "[top=42,left=16,bottom=16,right=16]" },
        children: schematic.nodes.filter((node) => node.group === group.id).map((node) => leaf(node.id)),
      })),
      ...schematic.nodes.filter((node) => node.group == null).map((node) => leaf(node.id)),
    ],
    edges: schematic.edges.map((edge, index) => ({ id: `edge-${index}`, sources: [edge.from], targets: [edge.to] })),
  };
  const layout = await elk.layout(graph);
  const placements = new Map<string, Placement>();
  for (const child of layout.children ?? []) {
    placements.set(child.id, { x: child.x ?? 0, y: child.y ?? 0, width: child.width, height: child.height });
    for (const grandchild of child.children ?? []) placements.set(grandchild.id, { x: grandchild.x ?? 0, y: grandchild.y ?? 0 });
  }
  return { placements, contentHeight: layout.height ?? 0 };
}

function SchematicFlow({ schematic, canvasHeight, onOpenRef, onContentHeight }: { schematic: Schematic; canvasHeight: number | null; onOpenRef?: (ref: string) => void; onContentHeight: (height: number) => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(useMemo(() => flowNodes(schematic), [schematic]));
  const edges = useMemo(() => flowEdges(schematic), [schematic]);
  const nodesInitialized = useNodesInitialized();
  const { getNodes, fitView } = useReactFlow();
  const [laidOut, setLaidOut] = useState(false);
  const [fitted, setFitted] = useState(false);
  const flowRef = useRef<HTMLDivElement | null>(null);
  const interactedRef = useRef(false);

  // Nodes render hidden at the origin first so ELK can lay out real DOM sizes.
  useEffect(() => {
    if (!nodesInitialized || laidOut) return;
    let cancelled = false;
    void elkPlacements(schematic, getNodes()).then(({ placements, contentHeight }) => {
      if (cancelled) return;
      setNodes((current) => current.map((node) => {
        const placement = placements.get(node.id);
        if (placement == null) return node;
        if (node.type === "frame") return { ...node, position: { x: placement.x, y: placement.y }, style: { width: placement.width, height: placement.height } };
        return { ...node, position: { x: placement.x, y: placement.y } };
      }));
      onContentHeight(contentHeight);
      setLaidOut(true);
    });
    return () => { cancelled = true; };
  }, [nodesInitialized, laidOut, schematic, getNodes, setNodes, onContentHeight]);

  // Fit only after the canvas has resized to the laid-out content; fitting
  // earlier measures the pre-resize container and leaves the diagram clipped.
  // Double rAF gives React Flow's ResizeObserver a frame to pick up the size.
  useEffect(() => {
    if (!laidOut || canvasHeight == null) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        void fitView({ padding: 0.1, maxZoom: 1.25 });
        setFitted(true);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [laidOut, canvasHeight, fitView]);

  // The canvas resizes after the initial fit (streamed sibling panels settle,
  // fonts load, window resizes); keep the diagram fitted until the user takes
  // over with their own pan/zoom.
  useEffect(() => {
    if (!fitted) return;
    const el = flowRef.current;
    if (el == null) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (interactedRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void fitView({ padding: 0.1, maxZoom: 1.25 }));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [fitted, fitView]);

  return <ReactFlow
    ref={flowRef}
    className={fitted ? undefined : "schematic-measuring"}
    onMoveStart={(event) => {
      if (event != null) interactedRef.current = true;
    }}
    onNodeDragStart={() => {
      interactedRef.current = true;
    }}
    nodes={nodes}
    edges={edges}
    onNodesChange={onNodesChange}
    nodeTypes={nodeTypes}
    nodesConnectable={false}
    edgesFocusable={false}
    minZoom={0.2}
    maxZoom={2}
    onNodeClick={(_, node) => {
      const ref = (node.data as Partial<CardData>).refText;
      if (ref != null) onOpenRef?.(ref);
    }}
  >
    <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
    <Controls showInteractive={false} fitViewOptions={{ padding: 0.1, maxZoom: 1.25 }} />
  </ReactFlow>;
}

export function SchematicDiagram({ code, fileLinks }: { code: string; fileLinks?: FileLinkContext }) {
  const parsed = useMemo<{ schematic: Schematic } | { error: string }>(() => {
    try {
      return { schematic: parseSchematic(code) };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  }, [code]);

  // Size the canvas to the laid-out diagram so small schematics do not float
  // in a fixed-height sea of dead space; the CSS clamp only pre-sizes it.
  const [canvasHeight, setCanvasHeight] = useState<number | null>(null);
  const fitCanvasHeight = useCallback((contentHeight: number) => {
    setCanvasHeight(Math.round(Math.min(Math.max(contentHeight + 96, 240), 680)));
  }, []);

  if ("error" in parsed) {
    return <div className="schematic-error">
      <p>Schematic render failed: {parsed.error}</p>
      <pre><code>{code}</code></pre>
    </div>;
  }

  function openRef(ref: string) {
    if (fileLinks == null) return;
    const match = /^(.+):(\d+)/.exec(ref);
    if (match == null) return;
    void openFileInEditor(fileLinks.prUrl, match[1], Number.parseInt(match[2], 10));
  }

  return <div className="schematic-block">
    {parsed.schematic.title != null && <span className="schematic-title">{parsed.schematic.title}</span>}
    <div className="schematic-canvas" style={canvasHeight == null ? undefined : { height: canvasHeight }}>
      <ReactFlowProvider>
        <SchematicFlow key={code} schematic={parsed.schematic} canvasHeight={canvasHeight} onOpenRef={fileLinks == null ? undefined : openRef} onContentHeight={fitCanvasHeight} />
      </ReactFlowProvider>
    </div>
  </div>;
}
