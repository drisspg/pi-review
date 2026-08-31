import type { ThemeName } from "../types";

export const themes: Array<{ name: ThemeName; label: string; light: boolean }> = [
  { name: "github-dark", label: "GitHub dark", light: false },
  { name: "github-dimmed", label: "GitHub dimmed", light: false },
  { name: "github-light", label: "GitHub light", light: true },
  { name: "catppuccin-mocha", label: "Catppuccin Mocha", light: false },
  { name: "gruvbox-dark", label: "Gruvbox dark", light: false },
  { name: "nord", label: "Nord", light: false },
  { name: "solarized-light", label: "Solarized light", light: true },
];

export function isLightTheme(name: string | undefined): boolean {
  return themes.some((theme) => theme.name === name && theme.light);
}
