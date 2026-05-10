import { CheckIcon, CopyIcon } from "@primer/octicons-react";
import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { api } from "../api";
import { highlightedHtml } from "../lib/highlight";

const fileReferencePattern = /((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_+-]+):(\d+)(?:-(\d+))?/g;
const fileReferenceExactPattern = /^((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_+-]+):(\d+)(?:-(\d+))?$/;
const fileReferenceUrlPrefix = "pi-review-file://";

type FileLinkContext = { prUrl: string };
type FileReference = { path: string; line: number; endLine?: number };

export const CodeText = React.memo(function CodeText({ code, language }: { code: string; language: string }) {
  return <code dangerouslySetInnerHTML={{ __html: highlightedHtml(code, language) }} />;
});

export function MarkdownText({ text, fileLinks }: { text: string; fileLinks?: FileLinkContext }) {
  const components = fileLinks == null ? { code: MarkdownCode, pre: MarkdownPre } : { code: (props: MarkdownCodeProps) => <MarkdownCode {...props} fileLinks={fileLinks} />, pre: MarkdownPre, a: (props: MarkdownAnchorProps) => <MarkdownAnchor {...props} fileLinks={fileLinks} /> };
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkFileReferenceLinks]} components={components}>{text}</ReactMarkdown></div>;
}

type MarkdownCodeProps = { className?: string; children?: React.ReactNode; fileLinks?: FileLinkContext };
type MarkdownPreProps = React.HTMLAttributes<HTMLPreElement> & { children?: React.ReactNode };
type MarkdownAnchorProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & { fileLinks?: FileLinkContext };

function MarkdownCode({ className, children, fileLinks }: MarkdownCodeProps) {
  const code = String(children ?? "").replace(/\n$/, "");
  if (fileLinks != null) {
    const reference = parseFileReference(code);
    if (reference != null) return <FileReferenceAnchor context={fileLinks} reference={reference}><code>{code}</code></FileReferenceAnchor>;
  }
  const language = className?.match(/language-(\w+)/)?.[1] ?? "";
  return <code dangerouslySetInnerHTML={{ __html: highlightedHtml(code, language) }} />;
}

function MarkdownPre({ children, ...props }: MarkdownPreProps) {
  const [copied, setCopied] = useState(false);
  const code = codeBlockText(children);

  async function copyCode() {
    await writeClipboard(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return <div className="markdown-code-block"><button className="markdown-copy-button" type="button" onClick={() => void copyCode()} aria-label={copied ? "Copied code" : "Copy code"} title={copied ? "Copied" : "Copy"}>{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}</button><pre {...props}>{children}</pre></div>;
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
  return <a className="file-reference-link" href="#" title="Open in VS Code" onMouseDown={open} onClick={open}>{children}</a>;
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
