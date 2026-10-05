import { useEffect, useRef } from "react";

import { api } from "../api";

/** Where focused time is attributed: a specific PR review, or the home page (queues, inbox, triage). */
export type ActivityContext = { surface: "review"; prKey: string } | { surface: "home" };

const TICK_MS = 5_000;
/** No keyboard/mouse/scroll input for this long means you stepped away; time stops counting. */
const IDLE_MS = 90_000;
const FLUSH_MS = 30_000;

function send(context: ActivityContext, ms: number, keepalive: boolean): void {
  if (ms <= 0) return;
  void api("/api/activity/heartbeat", { method: "POST", keepalive, body: JSON.stringify({ ...context, ms }) }).catch(() => undefined);
}

/**
 * Count focused review time: only while the tab is visible, the window has focus, and there was
 * input in the last 90s. Time accrues in 5s ticks and flushes every 30s, on context switches,
 * and when the page is hidden, so closing a tab loses at most one tick.
 */
export function useActivityTracker(context: ActivityContext): void {
  const contextRef = useRef(context);
  const pendingRef = useRef(0);
  const lastInputRef = useRef(Date.now());
  const key = context.surface === "review" ? `review:${context.prKey}` : "home";

  useEffect(() => {
    const previous = contextRef.current;
    if ((previous.surface === "review" ? `review:${previous.prKey}` : "home") !== key) {
      send(previous, pendingRef.current, false);
      pendingRef.current = 0;
    }
    contextRef.current = context;
    lastInputRef.current = Date.now();
    // `key` identifies the context; the object itself is recreated on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const markInput = () => { lastInputRef.current = Date.now(); };
    const flush = (keepalive: boolean) => {
      send(contextRef.current, pendingRef.current, keepalive);
      pendingRef.current = 0;
    };
    const onHidden = () => { if (document.visibilityState === "hidden") flush(true); };
    const onPageHide = () => flush(true);
    const events = ["keydown", "mousedown", "mousemove", "wheel", "scroll", "touchstart"] as const;
    for (const name of events) window.addEventListener(name, markInput, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    const timer = window.setInterval(() => {
      const focused = document.visibilityState === "visible" && document.hasFocus();
      if (focused && Date.now() - lastInputRef.current < IDLE_MS) pendingRef.current += TICK_MS;
      if (pendingRef.current >= FLUSH_MS) flush(false);
    }, TICK_MS);
    return () => {
      flush(true);
      window.clearInterval(timer);
      for (const name of events) window.removeEventListener(name, markInput, { capture: true });
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);
}
