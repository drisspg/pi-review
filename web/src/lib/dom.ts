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
