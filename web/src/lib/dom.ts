/** Read a design-token custom property as a concrete value (diagram renderers cannot use var() strings). */
export function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

export function autoGrowTextarea(element: HTMLTextAreaElement | null): void {
  if (element == null) return;
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, Math.round(window.innerHeight * 0.34))}px`;
}

function writeClipboardFallback(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

/** Copy text via the clipboard API, falling back to execCommand when the API is missing or denied. */
export async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard != null) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      writeClipboardFallback(text);
      return;
    }
  }
  writeClipboardFallback(text);
}
