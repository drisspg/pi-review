import React, { lazy, Suspense } from "react";

import { highlightedHtml } from "../lib/highlight";
import { InlineSnippetsProvider, type FileLinkContext } from "./MarkdownContext";

const MarkdownTextRenderer = lazy(() => import("./MarkdownRenderer").then((module) => ({ default: module.MarkdownTextRenderer })));

export { InlineSnippetsProvider };

export const CodeText = React.memo(function CodeText({ code, language, syntaxContext }: { code: string; language: string; syntaxContext?: "string" }) {
  return <code dangerouslySetInnerHTML={{ __html: highlightedHtml(code, language, syntaxContext) }} />;
});

export function MarkdownText({ text, fileLinks, inlineFinding }: { text: string; fileLinks?: FileLinkContext; inlineFinding?: boolean }) {
  return <Suspense fallback={<div className="markdown">{text}</div>}><MarkdownTextRenderer text={text} fileLinks={fileLinks} inlineFinding={inlineFinding} /></Suspense>;
}
