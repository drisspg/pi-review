import type { PullFile } from "./types.js";

export type GitattributesRule = {
  pattern: string;
  generated: boolean;
};

export function parseGitattributes(text: string): GitattributesRule[] {
  return text.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) return [];
    const [pattern, ...attrs] = trimmed.split(/\s+/);
    const generated = attrs.reduce<boolean | null>((current, attr) => {
      switch (attr) {
        case "linguist-generated":
        case "linguist-generated=true":
          return true;
        case "-linguist-generated":
        case "linguist-generated=false":
          return false;
        default:
          return current;
      }
    }, null);
    return generated == null ? [] : [{ pattern, generated }];
  });
}

export function isGeneratedPath(path: string, rules: GitattributesRule[]): boolean {
  return rules.reduce((generated, rule) => patternMatchesPath(rule.pattern, path) ? rule.generated : generated, false);
}

export function markGeneratedPullFiles(files: PullFile[], gitattributesText: string | null): PullFile[] {
  if (gitattributesText == null || gitattributesText.trim().length === 0) return files;
  const rules = parseGitattributes(gitattributesText);
  if (rules.length === 0) return files;
  return files.map((file) => isGeneratedPath(file.filename, rules) ? { ...file, generated: true } : file);
}

function patternMatchesPath(pattern: string, path: string): boolean {
  const normalizedPattern = pattern.replace(/^\//, "");
  if (normalizedPattern.endsWith("/")) return path.startsWith(normalizedPattern);
  if (!normalizedPattern.includes("/")) return globSegmentRegex(normalizedPattern).test(path.split("/").at(-1) ?? path);
  return globPathRegex(normalizedPattern).test(path);
}

function globPathRegex(pattern: string): RegExp {
  const source = pattern.split("/").map(globPathSegmentSource).join("/");
  return new RegExp(`^${source}$`);
}

function globSegmentRegex(pattern: string): RegExp {
  return new RegExp(`^${globPathSegmentSource(pattern)}$`);
}

function globPathSegmentSource(segment: string): string {
  if (segment === "**") return ".*";
  return escapeRegex(segment).replace(/\\\*/g, "[^/]*").replace(/\\\?/g, "[^/]");
}

function escapeRegex(text: string): string {
  return text.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
