import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { api } from "../api";
import { highlightedHtml } from "../lib/highlight";

const fileReferencePattern = /((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_+-]+):(\d+)(?:-(\d+))?/g;

type FileLinkContext = { prUrl: string };
type FileReference = { path: string; line: number; endLine?: number };

export function CodeText({ code, language }: { code: string; language: string }) {
  return <code dangerouslySetInnerHTML={{ __html: highlightedHtml(code, language) }} />;
}

export function MarkdownText({ text, fileLinks }: { text: string; fileLinks?: FileLinkContext }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: MarkdownCode }}>{text}</ReactMarkdown>{fileLinks != null && <FileReferenceLinks text={text} context={fileLinks} />}</div>;
}

function MarkdownCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const code = String(children ?? "").replace(/\n$/, "");
  const language = className?.match(/language-(\w+)/)?.[1] ?? "";
  return <code dangerouslySetInnerHTML={{ __html: highlightedHtml(code, language) }} />;
}

function FileReferenceLinks({ text, context }: { text: string; context: FileLinkContext }) {
  const references = fileReferences(text);
  if (references.length === 0) return null;
  return <div className="file-reference-links" aria-label="Source file links">{references.map((reference) => <button key={`${reference.path}:${reference.line}:${reference.endLine ?? ""}`} onClick={() => void openFileReference(context, reference)} title="Open in VS Code">{reference.path}:{reference.endLine == null ? reference.line : `${reference.line}-${reference.endLine}`}</button>)}</div>;
}

function fileReferences(text: string): FileReference[] {
  const references = new Map<string, FileReference>();
  for (const match of text.matchAll(fileReferencePattern)) {
    const path = match[1];
    const line = Number.parseInt(match[2], 10);
    const endLine = match[3] == null ? undefined : Number.parseInt(match[3], 10);
    if (!Number.isFinite(line)) continue;
    references.set(`${path}:${line}:${endLine ?? ""}`, { path, line, endLine });
  }
  return [...references.values()];
}

async function openFileReference(context: FileLinkContext, reference: FileReference) {
  await api<{ target: string }>("/api/file/open", { method: "POST", body: JSON.stringify({ prUrl: context.prUrl, path: reference.path, line: reference.line }) });
}
