export function prUrlFromKey(key: string): string {
  const match = key.match(/^(https?:\/\/[^/]+|[^/]+)\/([^/]+)\/([^#]+)#(\d+)$/);
  if (match == null) return key;
  const host = match[1].startsWith("http") ? new URL(match[1]).host : match[1];
  return `https://${host}/${match[2]}/${match[3]}/pull/${match[4]}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

export function newId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}
