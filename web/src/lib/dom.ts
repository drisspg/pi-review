export function autoGrowTextarea(element: HTMLTextAreaElement | null): void {
  if (element == null) return;
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, Math.round(window.innerHeight * 0.34))}px`;
}
