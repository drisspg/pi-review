import React, { useEffect, useRef, useState } from "react";
import type mermaidNs from "mermaid";

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
        if (!cancelled) setSvg(rendered);
      } catch (err) {
        if (cancelled) return;
        setSvg(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [code, themeTick]);

  if (error != null) {
    return <div className="mermaid-error">
      <p>Mermaid render failed: {error}</p>
      <pre><code>{code}</code></pre>
    </div>;
  }
  if (svg == null) return <div className="mermaid-placeholder" aria-label="Rendering diagram" />;
  return <div className="mermaid-rendered" dangerouslySetInnerHTML={{ __html: svg }} />;
}
