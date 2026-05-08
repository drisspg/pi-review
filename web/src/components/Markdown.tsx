import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { highlightedHtml } from "../lib/highlight";

export function CodeText({ code, language }: { code: string; language: string }) {
  return <code dangerouslySetInnerHTML={{ __html: highlightedHtml(code, language) }} />;
}

export function MarkdownText({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: MarkdownCode }}>{text}</ReactMarkdown></div>;
}

function MarkdownCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const code = String(children ?? "").replace(/\n$/, "");
  const language = className?.match(/language-(\w+)/)?.[1] ?? "";
  return <code dangerouslySetInnerHTML={{ __html: highlightedHtml(code, language) }} />;
}
