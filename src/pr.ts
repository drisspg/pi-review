import type { PullRequestRef } from "./types.js";

export function prKey(ref: PullRequestRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`;
}

export function parsePullRequestRef(raw: string): PullRequestRef {
  const input = raw.trim();
  const shorthand = input.match(/^([^\s/#]+)\/([^\s/#]+)#(\d+)$/);
  if (shorthand != null) {
    return { host: "github.com", owner: shorthand[1], repo: shorthand[2], number: Number.parseInt(shorthand[3], 10) };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a PR URL like https://github.com/OWNER/REPO/pull/123 or OWNER/REPO#123");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[2] !== "pull") {
    throw new Error("Expected a GitHub pull request URL like https://github.com/OWNER/REPO/pull/123");
  }

  const number = Number.parseInt(parts[3], 10);
  if (!Number.isInteger(number)) throw new Error(`Invalid pull request number: ${parts[3]}`);
  return { host: url.hostname, owner: parts[0], repo: parts[1], number };
}
