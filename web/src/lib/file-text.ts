import { api } from "../api";

const fileTextCache = new Map<string, Promise<string>>();

/** Fetch a file at a SHA through the server (local clone first), memoized per PR/sha/path for the tab's lifetime. */
export function loadFileText(prUrl: string, path: string, sha: string): Promise<string> {
  const key = `${prUrl}::${sha}::${path}`;
  const existing = fileTextCache.get(key);
  if (existing != null) return existing;
  const promise = api<{ text: string }>("/api/file/text", { method: "POST", body: JSON.stringify({ prUrl, path, sha }) }).then((response) => response.text).catch((err) => {
    fileTextCache.delete(key);
    throw err;
  });
  fileTextCache.set(key, promise);
  return promise;
}
