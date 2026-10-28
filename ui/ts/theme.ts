export const THEMES = [
  { id: "system", label: "System" },
  { id: "paper", label: "Warm paper" },
  { id: "slate", label: "Slate" },
  { id: "black", label: "Black" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const IDS: readonly string[] = THEMES.map((theme) => theme.id);

export function isTheme(value: unknown): value is ThemeId {
  return typeof value === "string" && IDS.includes(value);
}

/** Presets live in styles.css keyed by this attribute; `system` is the default. */
export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
}
