import { CheckIcon, CopyIcon } from "@primer/octicons-react";
import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { api } from "../api";
import { highlightedHtml } from "../lib/highlight";
import { InlineSnippetsContext, type FileLinkContext } from "./MarkdownContext";
import { Mermaid } from "./Mermaid";

const fileReferencePattern = /((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_+-]+):(\d+)(?:-(\d+))?/g;
const fileReferenceExactPattern = /^((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_+-]+):(\d+)(?:-(\d+))?$/;
const fileReferenceCodePattern = /^((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_+-]+):(\d+)(?:-(\d+))?(?:\s+[—-].*)?$/;
const fileReferenceUrlPrefix = "pi-review-file://";

type FileReference = { path: string; line: number; endLine?: number };

const SNIPPET_CONTEXT_LINES = 2;
const fileTextCache = new Map<string, Promise<string>>();

async function loadFileText(prUrl: string, path: string, sha: string): Promise<string> {
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

function languageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs": return "ts";
    case "py": return "python";
    case "rs": return "rust";
    case "go": return "go";
    case "java": return "java";
    case "kt":
    case "kts": return "kotlin";
    case "rb": return "ruby";
    case "swift": return "swift";
    case "c":
    case "h": return "c";
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
    case "hh":
    case "cuh":
    case "cu": return "cpp";
    case "css": return "css";
    case "scss": return "scss";
    case "html":
    case "htm": return "html";
    case "json": return "json";
    case "yaml":
    case "yml": return "yaml";
    case "toml": return "toml";
    case "sh":
    case "bash":
    case "zsh": return "bash";
    case "md":
    case "markdown": return "markdown";
    default: return "";
  }
}

function InlineFileSnippet({ context, reference }: { context: FileLinkContext; reference: FileReference }) {
  const [state, setState] = React.useState<{ status: "loading" | "ready" | "error"; lines?: string[]; error?: string }>({ status: "loading" });
  const [collapsed, setCollapsed] = React.useState(false);
  React.useEffect(() => {
    if (context.headSha == null) {
      setState({ status: "error", error: "missing head SHA for snippet" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    loadFileText(context.prUrl, reference.path, context.headSha).then((text) => {
      if (cancelled) return;
      setState({ status: "ready", lines: text.split("\n") });
    }).catch((err) => {
      if (cancelled) return;
      setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
    });
    return () => { cancelled = true; };
  }, [context.headSha, context.prUrl, reference.path]);
  const start = Math.max(1, reference.line - SNIPPET_CONTEXT_LINES);
  const endLine = reference.endLine ?? reference.line;
  if (state.status === "loading") return <span className="file-snippet loading"><span className="file-snippet-head"><span className="file-snippet-path">{referenceLabel(reference)}</span><span className="file-snippet-status muted">loading…</span></span></span>;
  if (state.status === "error") return <span className="file-snippet error"><span className="file-snippet-head"><span className="file-snippet-path">{referenceLabel(reference)}</span><span className="file-snippet-status muted">{state.error}</span></span></span>;
  const lines = state.lines ?? [];
  const stop = Math.min(lines.length, endLine + SNIPPET_CONTEXT_LINES);
  const language = languageFromPath(reference.path);
  const slice = lines.slice(start - 1, stop);
  const html = highlightedHtml(slice.join("\n"), language);
  const rowHtmls = html.split("\n");
  return <span className={`file-snippet${collapsed ? " collapsed" : ""}`}>
    <span className="file-snippet-head" onClick={(event) => { event.preventDefault(); setCollapsed((current) => !current); }} role="button" aria-expanded={!collapsed} title={collapsed ? "Expand" : "Collapse"}>
      <span className="file-snippet-chevron" aria-hidden="true">{collapsed ? "›" : "⌄"}</span>
      <span className="file-snippet-path">{referenceLabel(reference)}</span>
    </span>
    {!collapsed && <span className="file-snippet-body">
      <span className="file-snippet-gutter" aria-hidden="true">{Array.from({ length: stop - start + 1 }, (_, index) => {
        const lineNumber = start + index;
        const inRange = lineNumber >= reference.line && lineNumber <= endLine;
        return <span key={lineNumber} className={`file-snippet-line-number${inRange ? " highlight" : ""}`}>{lineNumber}</span>;
      })}</span>
      <span className="file-snippet-code">{rowHtmls.map((row, index) => {
        const lineNumber = start + index;
        const inRange = lineNumber >= reference.line && lineNumber <= endLine;
        return <span key={index} className={`file-snippet-line${inRange ? " highlight" : ""}`} dangerouslySetInnerHTML={{ __html: row.length > 0 ? row : "&nbsp;" }} />;
      })}</span>
    </span>}
  </span>;
}

export function MarkdownTextRenderer({ text, fileLinks }: { text: string; fileLinks?: FileLinkContext }) {
  const inlineCtx = React.useContext(InlineSnippetsContext);
  const mergedFileLinks: FileLinkContext | undefined = fileLinks == null ? undefined : { ...fileLinks, headSha: fileLinks.headSha ?? inlineCtx?.headSha, snippets: fileLinks.snippets ?? inlineCtx?.snippets ?? false };
  const components = mergedFileLinks == null ? { code: MarkdownCode, pre: MarkdownPre } : { code: (props: MarkdownCodeProps) => <MarkdownCode {...props} fileLinks={mergedFileLinks} />, pre: MarkdownPre, a: (props: MarkdownAnchorProps) => <MarkdownAnchor {...props} fileLinks={mergedFileLinks} /> };
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkFileReferenceLinks]} components={components}>{text}</ReactMarkdown></div>;
}

type MarkdownCodeProps = { className?: string; children?: React.ReactNode; fileLinks?: FileLinkContext };
type MarkdownPreProps = React.HTMLAttributes<HTMLPreElement> & { children?: React.ReactNode };
type MarkdownAnchorProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & { fileLinks?: FileLinkContext };

function MarkdownCode({ className, children, fileLinks }: MarkdownCodeProps) {
  const code = String(children ?? "").replace(/\n$/, "");
  if (fileLinks != null) {
    const reference = parseCodeFileReference(code);
    if (reference != null) return <FileReferenceAnchor context={fileLinks} reference={reference}><code>{code}</code></FileReferenceAnchor>;
  }
  const language = className?.match(/language-(\w+)/)?.[1] ?? "";
  return <code dangerouslySetInnerHTML={{ __html: highlightedHtml(code, language) }} />;
}

function MarkdownPre({ children, ...props }: MarkdownPreProps) {
  const [copied, setCopied] = useState(false);
  const code = codeBlockText(children);
  const language = preBlockLanguage(children);
  if (language === "mermaid") return <div className="markdown-mermaid-block"><Mermaid code={code} /></div>;

  async function copyCode() {
    await writeClipboard(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return <div className="markdown-code-block"><button className="markdown-copy-button" type="button" onClick={() => void copyCode()} aria-label={copied ? "Copied code" : "Copy code"} title={copied ? "Copied" : "Copy"}>{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}</button><pre {...props}>{children}</pre></div>;
}

function preBlockLanguage(children: React.ReactNode): string | null {
  if (Array.isArray(children)) {
    for (const child of children) {
      const match = preBlockLanguage(child);
      if (match != null) return match;
    }
    return null;
  }
  if (!React.isValidElement<{ className?: string }>(children)) return null;
  const className = children.props.className ?? "";
  const match = className.match(/language-([\w-]+)/);
  return match == null ? null : match[1];
}

function MarkdownAnchor({ href, children, fileLinks, ...props }: MarkdownAnchorProps) {
  if (fileLinks != null) {
    const reference = referenceFromUrl(href);
    if (reference != null) return <FileReferenceAnchor context={fileLinks} reference={reference}>{children}</FileReferenceAnchor>;
  }
  return <a href={href} {...props}>{children}</a>;
}

function FileReferenceAnchor({ context, reference, children }: { context: FileLinkContext; reference: FileReference; children: React.ReactNode }) {
  function open(event: React.MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    void openFileReference(context, reference);
  }
  const link = <a className="file-reference-link" href="#" title="Open in VS Code" onMouseDown={open} onClick={open}>{children}</a>;
  if (!context.snippets || context.headSha == null) return link;
  return <span className="file-reference-with-snippet">{link}<InlineFileSnippet context={context} reference={reference} /></span>;
}

function remarkFileReferenceLinks() {
  return (tree: unknown) => visitTextNodes(tree);
}

function visitTextNodes(node: unknown): void {
  if (!isNode(node)) return;
  if (!Array.isArray(node.children)) return;
  node.children = node.children.flatMap((child) => {
    if (!isNode(child)) return [child];
    if (child.type === "text" && typeof child.value === "string") return splitTextReferences(child.value);
    visitTextNodes(child);
    return [child];
  });
}

function splitTextReferences(value: string): unknown[] {
  const nodes: unknown[] = [];
  let offset = 0;
  for (const match of value.matchAll(fileReferencePattern)) {
    const index = match.index ?? 0;
    if (index > offset) nodes.push({ type: "text", value: value.slice(offset, index) });
    const reference = referenceFromMatch(match);
    nodes.push({ type: "link", url: fileReferenceHref(reference), children: [{ type: "text", value: referenceLabel(reference) }] });
    offset = index + match[0].length;
  }
  if (offset < value.length) nodes.push({ type: "text", value: value.slice(offset) });
  return nodes.length === 0 ? [{ type: "text", value }] : nodes;
}

function parseFileReference(value: string): FileReference | null {
  const match = value.match(fileReferenceExactPattern);
  return match == null ? null : referenceFromMatch(match);
}

function parseCodeFileReference(value: string): FileReference | null {
  const match = value.match(fileReferenceCodePattern);
  return match == null ? null : referenceFromMatch(match);
}

function referenceFromUrl(url?: string): FileReference | null {
  if (url == null || !url.startsWith(fileReferenceUrlPrefix)) return null;
  return parseFileReference(decodeURIComponent(url.slice(fileReferenceUrlPrefix.length)));
}

function referenceFromMatch(match: RegExpMatchArray): FileReference {
  const endLine = match[3] == null ? undefined : Number.parseInt(match[3], 10);
  return { path: match[1], line: Number.parseInt(match[2], 10), endLine };
}

function referenceLabel(reference: FileReference): string {
  return `${reference.path}:${reference.endLine == null ? reference.line : `${reference.line}-${reference.endLine}`}`;
}

function fileReferenceHref(reference: FileReference): string {
  return `${fileReferenceUrlPrefix}${encodeURIComponent(referenceLabel(reference))}`;
}

function isNode(value: unknown): value is { type?: string; value?: unknown; children?: unknown[] } {
  return typeof value === "object" && value !== null;
}

function codeBlockText(value: React.ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(codeBlockText).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(value)) return codeBlockText(value.props.children);
  return "";
}

async function writeClipboard(text: string) {
  if (navigator.clipboard != null) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function openFileReference(context: FileLinkContext, reference: FileReference) {
  await api<{ target: string }>("/api/file/open", { method: "POST", body: JSON.stringify({ prUrl: context.prUrl, path: reference.path, line: reference.line }) });
}
