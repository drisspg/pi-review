import { useEffect, useMemo, useRef, useState } from "react";

import { openFileInEditor } from "../api";
import { overviewFrameDocument, overviewMessages, overviewTabDocument, parseOverviewRef, type OverviewTheme } from "../lib/overview-page";
import { isLightTheme } from "../lib/theme";

const appTheme = (): OverviewTheme => isLightTheme(document.documentElement.dataset.theme) ? "light" : "dark";

function useAppTheme(): OverviewTheme {
  const [theme, setTheme] = useState(appTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(appTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** Open the page by itself in a new tab, still sandboxed. */
export function openOverviewInTab(html: string): void {
  const url = URL.createObjectURL(new Blob([overviewTabDocument(html, appTheme())], { type: "text/html" }));
  window.open(url, "_blank", "noopener");
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// One editor open (or walkthrough step) per gesture: page script cannot repeat them between gestures.
const MESSAGE_GAP_MS = 500;

export function OverviewPage({ html, prUrl }: { html: string; prUrl: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const theme = useAppTheme();
  const currentTheme = useRef(theme);
  currentTheme.current = theme;
  // Theme changes are posted in place so the page keeps its interactive state.
  const srcDoc = useMemo(() => overviewFrameDocument(html, currentTheme.current), [html]);
  const postTheme = () => frame.current?.contentWindow?.postMessage({ type: overviewMessages.theme, theme: currentTheme.current }, "*");
  useEffect(postTheme, [theme]);
  useEffect(() => {
    const last = { ref: 0, key: 0 };
    function onMessage(event: MessageEvent): void {
      // Act only on the frame's messages, right after the user clicked or typed inside it: the frame
      // holds focus only after a gesture in it, and activation alone may come from the app.
      if (event.source !== frame.current?.contentWindow || document.activeElement !== frame.current || !navigator.userActivation?.isActive) return;
      const kind = event.data?.type === overviewMessages.key ? "key" : "ref";
      if (performance.now() - last[kind] < MESSAGE_GAP_MS) return;
      if (kind === "key") {
        if (event.data.key !== "j") return;
        last.key = performance.now();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
        return;
      }
      const ref = event.data?.type === overviewMessages.ref ? parseOverviewRef(event.data.ref) : null;
      if (ref == null) return;
      last.ref = performance.now();
      void openFileInEditor(prUrl, ref.path, ref.line);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [prUrl]);
  return <iframe ref={frame} className="overview-page-frame" title="PR overview" sandbox="allow-scripts" srcDoc={srcDoc} onLoad={postTheme} />;
}
