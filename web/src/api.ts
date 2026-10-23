export class ApiError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

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

/** Set when the server reports its code was rebuilt after it started: only a restart helps. */
let staleServer = false;
const staleServerListeners = new Set<() => void>();
export const RESTART_HINT = "Pi Review's server is older than this page — restart it (Ctrl-C, then npm start) to use this feature.";

export function subscribeStaleServer(listener: () => void): () => void {
  staleServerListeners.add(listener);
  return () => staleServerListeners.delete(listener);
}

export function isStaleServer(): boolean {
  return staleServer;
}

function markStaleServer(): void {
  if (staleServer) return;
  staleServer = true;
  for (const listener of staleServerListeners) listener();
}

function trackBuild(response: Response): void {
  if (response.headers.get("x-pi-review-server-stale") === "1") markStaleServer();
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
  if (response.status === 404 && typeof body.error === "string" && body.error.startsWith("No route for")) {
    markStaleServer();
    throw new ApiError(RESTART_HINT, "SERVER_RESTART_REQUIRED");
  }
  if (!response.ok) throw new ApiError(body.error ?? `HTTP ${response.status}`, typeof body.code === "string" ? body.code : undefined);
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
