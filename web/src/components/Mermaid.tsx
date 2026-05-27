import React, { useEffect, useRef, useState } from "react";
import type mermaidNs from "mermaid";

type PanPoint = { x: number; y: number };
type DragState = { pointerId: number; startX: number; startY: number; originX: number; originY: number };

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.2;

type MermaidModule = typeof mermaidNs;

let modulePromise: Promise<MermaidModule> | null = null;

async function loadMermaid(): Promise<MermaidModule> {
  if (modulePromise == null) {
    modulePromise = import("mermaid").then((module) => module.default);
  }
  return modulePromise;
}

function mermaidTheme(): "dark" | "default" {
  const theme = document.documentElement.dataset.theme ?? "github-dark";
  return theme === "github-light" ? "default" : "dark";
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
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", fontFamily: "inherit", theme: mermaidTheme() });
        const { svg: rendered } = await mermaid.render(nextRenderId(), code);
        if (!cancelled) {
          setSvg(rendered);
          setZoom(1);
          setPan({ x: 0, y: 0 });
        }
      } catch (err) {
        if (cancelled) return;
        setSvg(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [code, themeTick]);

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

  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
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
      <pre><code>{code}</code></pre>
    </div>;
  }
  if (svg == null) return <div className="mermaid-placeholder" aria-label="Rendering diagram" />;
  return <div className="mermaid-zoom-shell">
    <div className="mermaid-zoom-controls" aria-label="Diagram zoom controls">
      <span className="mermaid-zoom-hint">Drag to pan · wheel to zoom</span>
      <button type="button" onClick={() => applyZoom(zoom - ZOOM_STEP)}>−</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" onClick={() => applyZoom(zoom + ZOOM_STEP)}>+</button>
      <button type="button" onClick={resetView}>Reset</button>
    </div>
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
