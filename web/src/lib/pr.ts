export function prUrlFromKey(key: string): string {
  const match = key.match(/^(https?:\/\/[^/]+|[^/]+)\/([^/]+)\/([^#]+)#(\d+)$/);
  if (match == null) return key;
  const host = match[1].startsWith("http") ? new URL(match[1]).host : match[1];
  return `https://${host}/${match[2]}/${match[3]}/pull/${match[4]}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

export function relativeTime(iso: string | null | undefined): string {
  if (iso == null) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.round(diff / minute)}m ago`;
  if (diff < day) return `${Math.round(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.round(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function newId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}
