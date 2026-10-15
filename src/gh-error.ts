/**
 * One-line, user-facing reason for a failed `gh` call. execFile errors start with
 * "Command failed: gh api graphql -f query=…" (the whole query), so the reason is in the
 * trailing lines; connection failures get a plain "can't reach GitHub" message.
 */
export function summarizeGhError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = typeof (error as { stderr?: unknown } | null)?.stderr === "string" ? (error as { stderr: string }).stderr : "";
  const text = `${message}\n${stderr}`;
  if (/network is unreachable|error connecting to api\.github\.com|dial tcp|no such host|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|i\/o timeout/i.test(text)) {
    return "can't reach GitHub (offline, or a network/VPN problem)";
  }
  const ghLine = /gh: (.+)$/m.exec(text)?.[1];
  if (ghLine != null) return ghLine.trim().slice(0, 160);
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("Command failed:"));
  return (lines.at(-1) ?? message).slice(0, 160);
}
