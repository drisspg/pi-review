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

export function highlightedHtml(code: string, language: string): string {
  if (language.length > 0 && hljs.getLanguage(language) != null) return hljs.highlight(code, { language }).value;
  return hljs.highlightAuto(code).value;
}
