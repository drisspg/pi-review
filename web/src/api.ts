/** Human-readable message for a caught unknown, usually an api() rejection. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build-staleness tracking: every API response carries the server's current
 * web-build id (x-pi-review-assets). The first one seen is this tab's build;
 * any later change means dist-web was rebuilt underneath us, so the app offers
 * a reload instead of limping along with mixed assets. No polling involved —
 * detection rides on traffic the app already generates.
 */
let tabBuild: string | null = null;
let staleBuild = false;
const staleBuildListeners = new Set<() => void>();

export function subscribeStaleBuild(listener: () => void): () => void {
  staleBuildListeners.add(listener);
  return () => staleBuildListeners.delete(listener);
}

export function isStaleBuild(): boolean {
  return staleBuild;
}

function trackBuild(response: Response): void {
  if (staleBuild || import.meta.env.DEV) return;
  const version = response.headers.get("x-pi-review-assets");
  if (version == null || version === "unbuilt") return;
  if (tabBuild == null) {
    tabBuild = version;
    return;
  }
  if (version !== tabBuild) {
    staleBuild = true;
    for (const listener of staleBuildListeners) listener();
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  trackBuild(response);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}

/** Fire-and-forget local usage event for the friction/feature monitor; must never block or throw. */
export function logUsage(name: string, data?: Record<string, unknown>): void {
  void api("/api/usage", { method: "POST", body: JSON.stringify({ events: [{ name, data }] }) }).catch(() => undefined);
}

/** Ask the server to open a PR worktree file location in the reviewer's editor. */
export async function openFileInEditor(prUrl: string, path: string, line: number): Promise<void> {
  await api("/api/file/open", { method: "POST", body: JSON.stringify({ prUrl, path, line }) });
}
