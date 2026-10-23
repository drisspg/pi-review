import { useState } from "react";

const STORAGE_KEY = "pi-review-collapsed-sections";

function readCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/** Collapsible home-page section whose state survives reloads (per browser). */
export function useCollapsedSection(id: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => readCollapsed().has(id));
  function toggle(): void {
    const next = readCollapsed();
    if (next.has(id)) next.delete(id);
    else next.add(id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    setCollapsed(next.has(id));
  }
  return [collapsed, toggle];
}
