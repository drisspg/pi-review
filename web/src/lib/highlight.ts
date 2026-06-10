import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);
hljs.registerLanguage("typescript", typescript);

export function languageForPath(path: string | null | undefined): string {
  if (path == null) return "";
  if (/\.(cc|cpp|cu|cuh|c|h|hpp)$/.test(path)) return "cpp";
  if (/\.tsx?$/.test(path)) return "typescript";
  if (/\.jsx?$/.test(path)) return "javascript";
  if (/\.py$/.test(path)) return "python";
  if (/\.json$/.test(path)) return "json";
  if (/\.(sh|bash|zsh)$/.test(path)) return "bash";
  return "";
}

const highlightedCache = new Map<string, string>();
const maxHighlightedCacheEntries = 5000;

export function highlightedHtml(code: string, language: string, syntaxContext?: "string"): string {
  const key = `${language}\0${syntaxContext ?? ""}\0${code}`;
  const cached = highlightedCache.get(key);
  if (cached != null) return cached;
  const html = highlightedCodeHtml(code, language, syntaxContext);
  highlightedCache.set(key, html);
  const oldestKey = highlightedCache.keys().next().value;
  if (highlightedCache.size > maxHighlightedCacheEntries && oldestKey != null) highlightedCache.delete(oldestKey);
  return html;
}

function highlightedCodeHtml(code: string, language: string, syntaxContext?: "string"): string {
  if (syntaxContext === "string") return highlightedStringLine(code);
  if (language.length === 0 || hljs.getLanguage(language) == null) return escapeHtml(code);
  if (/^[+\- ]/.test(code)) return highlightedDiffLine(code, language);
  return hljs.highlight(code, { language }).value;
}

function highlightedDiffLine(code: string, language: string): string {
  return `${escapeHtml(code[0])}${hljs.highlight(code.slice(1), { language }).value}`;
}

function highlightedStringLine(code: string): string {
  const prefix = /^[+\- ]/.test(code) ? code[0] : "";
  const text = prefix.length > 0 ? code.slice(1) : code;
  return `${escapeHtml(prefix)}<span class="hljs-string">${escapeHtml(text)}</span>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
