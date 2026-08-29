import React, { useEffect, useRef, useState } from "react";
import type mermaidNs from "mermaid";

import { errorMessage } from "../api";
import { cssVar } from "../lib/dom";import { Button } from "./Button";

type PanPoint = { x: number; y: number };
type DragState = { pointerId: number; startX: number; startY: number; originX: number; originY: number };

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.2;
const FIT_PADDING = 24;

type MermaidModule = typeof mermaidNs;

let modulePromise: Promise<MermaidModule> | null = null;

async function loadMermaid(): Promise<MermaidModule> {
  if (modulePromise == null) {
    // Cache only successful loads: a failed chunk fetch (e.g. stale hashed asset
    // after a redeploy) must stay retryable instead of poisoning every diagram.
    modulePromise = import("mermaid").then((module) => module.default).catch((error: unknown) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

function parseColor(value: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex != null) return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
  const rgb = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(value);
  if (rgb != null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/** Blend `amount` of fg into bg; mermaid needs concrete colors, not color-mix() strings. */
function blend(fg: string, bg: string, amount: number): string {
  const a = parseColor(fg);
  const b = parseColor(bg);
  if (a == null || b == null) return bg;
  const channels = a.map((channel, i) => Math.round(channel * amount + (b[i] ?? 0) * (1 - amount)));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** Derive a mermaid "base" theme from the app's design tokens so diagrams match all three themes. */
function mermaidThemeVariables(): Record<string, unknown> {
  const panel = cssVar("--panel", "#161b22");
  const panel2 = cssVar("--panel2", "#0d1117");
  const border = cssVar("--border", "#30363d");
  const text = cssVar("--text", "#e6edf3");
  const muted = cssVar("--muted", "#8b949e");
  const accent = cssVar("--accent", "#2f81f7");
  const threadAccent = cssVar("--thread-accent", "#a371f7");
  const attention = cssVar("--attention", "#d29922");
  const nodeBkg = blend(accent, panel, 0.09);
  const nodeBorder = blend(accent, border, 0.5);
  return {
    darkMode: (document.documentElement.dataset.theme ?? "github-dark") !== "github-light",
    background: panel2,
    fontSize: "14px",
    primaryColor: nodeBkg,
    primaryTextColor: text,
    primaryBorderColor: nodeBorder,
    mainBkg: nodeBkg,
    nodeBorder,
    nodeTextColor: text,
    textColor: text,
    titleColor: text,
    lineColor: blend(muted, border, 0.6),
    edgeLabelBackground: panel,
    clusterBkg: blend(text, panel2, 0.03),
    clusterBorder: border,
    secondaryColor: blend(threadAccent, panel, 0.12),
    secondaryBorderColor: blend(threadAccent, border, 0.4),
    tertiaryColor: panel2,
    tertiaryBorderColor: border,
    noteBkgColor: blend(attention, panel, 0.12),
    noteTextColor: text,
    noteBorderColor: blend(attention, border, 0.4),
    actorBkg: nodeBkg,
    actorBorder: nodeBorder,
    actorTextColor: text,
    signalColor: text,
    signalTextColor: text,
    labelBoxBkgColor: panel,
    labelTextColor: text,
    loopTextColor: muted,
    activationBkgColor: blend(accent, panel, 0.18),
    activationBorderColor: nodeBorder,
    pie1: blend(accent, panel, 0.75),
    pie2: blend(threadAccent, panel, 0.75),
    pie3: blend(cssVar("--success", "#3fb950"), panel, 0.75),
    pie4: blend(attention, panel, 0.75),
    pie5: blend(cssVar("--danger", "#f85149"), panel, 0.75),
    pie6: blend(accent, panel, 0.45),
    pie7: blend(threadAccent, panel, 0.45),
    pieTitleTextColor: text,
    pieSectionTextColor: text,
    pieLegendTextColor: muted,
  };
}

let renderCounter = 0;
function nextRenderId(): string {
  renderCounter += 1;
  return `mermaid-${Date.now().toString(36)}-${renderCounter}`;
}

export function Mermaid({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<PanPoint>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const themeRef = useRef<string>(document.documentElement.dataset.theme ?? "github-dark");

  useEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver(() => {
      const next = target.dataset.theme ?? "github-dark";
      if (next === themeRef.current) return;
      themeRef.current = next;
      setThemeTick((tick) => tick + 1);
    });
    observer.observe(target, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          fontFamily: "inherit",
          theme: "base",
          themeVariables: mermaidThemeVariables(),
          flowchart: { curve: "basis" },
        });
        const renderId = nextRenderId();
        let rendered: string;
        try {
          ({ svg: rendered } = await mermaid.render(renderId, code));
        } finally {
          document.getElementById(`d${renderId}`)?.remove();
        }
        if (!cancelled) {
          setSvg(rendered);
          setZoom(1);
          setPan({ x: 0, y: 0 });
        }
      } catch (err) {
        if (cancelled) return;
        setSvg(null);
        setError(errorMessage(err));
      }
    })();
    return () => { cancelled = true; };
  }, [code, themeTick]);

  function fitView() {
    const viewport = viewportRef.current;
    const svgEl = viewport?.querySelector("svg");
    if (viewport == null || svgEl == null) return;
    const rect = svgEl.getBoundingClientRect();
    const baseWidth = rect.width / zoomRef.current;
    const baseHeight = rect.height / zoomRef.current;
    if (baseWidth <= 0 || baseHeight <= 0) return;
    const fit = Math.min((viewport.clientWidth - FIT_PADDING * 2) / baseWidth, (viewport.clientHeight - FIT_PADDING * 2) / baseHeight, 1.5);
    const nextZoom = Math.max(MIN_ZOOM, fit);
    setZoom(nextZoom);
    setPan({ x: (viewport.clientWidth - baseWidth * nextZoom) / 2, y: Math.max((viewport.clientHeight - baseHeight * nextZoom) / 2, FIT_PADDING) });
  }

  // Start each diagram fitted and centered like a canvas, instead of 100% pinned top-left.
  useEffect(() => {
    if (svg == null) return;
    const frame = requestAnimationFrame(fitView);
    return () => cancelAnimationFrame(frame);
  }, [svg]);

  function applyZoom(nextZoom: number, anchor?: PanPoint) {
    const clampedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    const viewport = viewportRef.current;
    if (viewport == null || anchor == null) {
      setZoom(clampedZoom);
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const cursor = { x: anchor.x - rect.left, y: anchor.y - rect.top };
    setPan((current) => ({
      x: cursor.x - ((cursor.x - current.x) / zoom) * clampedZoom,
      y: cursor.y - ((cursor.y - current.y) / zoom) * clampedZoom,
    }));
    setZoom(clampedZoom);
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    applyZoom(zoom * (event.deltaY > 0 ? 0.9 : 1.1), { x: event.clientX, y: event.clientY });
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: pan.x, originY: pan.y };
    setDragging(true);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag == null || drag.pointerId !== event.pointerId) return;
    setPan({ x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY });
  }

  function stopDragging(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  }

  if (error != null) {
    return <div className="mermaid-error">
      <p>Mermaid render failed: {error}</p>
      {error.includes("dynamically imported module") && <p>The app was rebuilt underneath this tab — reload the page to fetch the new assets.</p>}
      <Button variant="muted" onClick={() => setThemeTick((tick) => tick + 1)}>Retry render</Button>
      <pre><code>{code}</code></pre>
    </div>;
  }
  if (svg == null) return <div className="mermaid-placeholder" aria-label="Rendering diagram" />;
  return <div className="mermaid-zoom-shell">
    <div className="mermaid-zoom-controls" aria-label="Diagram zoom controls">
      <Button variant="muted" onClick={() => applyZoom(zoom - ZOOM_STEP)}>−</Button>
      <span>{Math.round(zoom * 100)}%</span>
      <Button variant="muted" onClick={() => applyZoom(zoom + ZOOM_STEP)}>+</Button>
      <Button variant="muted" onClick={fitView}>Fit</Button>
    </div>
    <span className="mermaid-zoom-hint">Drag to pan · wheel to zoom</span>
    <div
      ref={viewportRef}
      className={`mermaid-viewport${dragging ? " dragging" : ""}`}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onDoubleClick={(event) => applyZoom(zoom + ZOOM_STEP, { x: event.clientX, y: event.clientY })}
    >
      <div className="mermaid-rendered" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  </div>;
}
