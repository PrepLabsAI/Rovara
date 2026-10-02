// Owner request of 2026-10-01 and spec 048 FR-001 and FR-008: the installer's design system. One
// stylesheet from 127.0.0.1 with no external asset, light and dark, readable contrast, visible
// focus, and every class the page uses defined.
import { describe, expect, it } from "vitest";
import { BASE_TOKENS, COLOR_TOKENS, PAGE_CLASSES, WIZARD_CSS, type ColorToken } from "../../packages/cli/src/init/ui/design.js";
import { WIZARD_CSS as SERVED_CSS } from "../../packages/cli/src/init/ui/page.js";

/** WCAG 2.2 relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

/** Text on a background: at least 4.5:1 (WCAG AA). */
const TEXT_PAIRS: Array<[ColorToken, ColorToken]> = [
  ["text", "surface"], ["text", "bg"], ["text", "accent-soft"], ["text", "bad-bg"],
  ["text-2", "surface"], ["text-2", "surface-2"], ["text-2", "bg"],
  ["accent", "surface"], ["accent", "surface-2"], ["accent", "accent-soft"], ["on-accent", "accent"], ["on-accent", "accent-hover"],
  ["ok", "ok-bg"], ["ok", "surface"], ["wait", "wait-bg"], ["wait", "surface"], ["bad", "bad-bg"], ["bad", "surface"],
];
/** A field's border and the focus ring: at least 3:1 (WCAG non-text contrast). */
const UI_PAIRS: Array<[ColorToken, ColorToken]> = [["field-border", "surface"], ["field-border", "surface-2"], ["focus", "surface"], ["focus", "bg"]];

describe("the installer's design system", () => {
  for (const mode of ["light", "dark"] as const) {
    it(`${mode}: every text color is readable on its background`, () => {
      for (const [text, background] of TEXT_PAIRS) {
        const ratio = Number(contrast(COLOR_TOKENS[mode][text], COLOR_TOKENS[mode][background]).toFixed(2));
        // Labelled so a failure names the pair and mode, and can actually fail (passes is computed
        // from the measured ratio, then checked against the required true).
        expect({ mode, text, background, ratio, passes: ratio >= 4.5 }).toEqual({ mode, text, background, ratio, passes: true });
      }
    });
    it(`${mode}: field borders and the focus ring stand out`, () => {
      for (const [line, background] of UI_PAIRS) expect(contrast(COLOR_TOKENS[mode][line], COLOR_TOKENS[mode][background])).toBeGreaterThanOrEqual(3);
    });
  }

  it("has the same tokens in both modes, all of them in the stylesheet", () => {
    expect(Object.keys(COLOR_TOKENS.dark).sort()).toEqual(Object.keys(COLOR_TOKENS.light).sort());
    for (const name of [...Object.keys(COLOR_TOKENS.light), ...Object.keys(BASE_TOKENS)]) expect(WIZARD_CSS).toContain(`--${name}: `);
    expect(WIZARD_CSS).toContain("@media (prefers-color-scheme: dark)");
  });

  it("loads nothing from anywhere: no web font, no image, no import", () => {
    expect(WIZARD_CSS).not.toMatch(/url\(|@import|@font-face|https?:/);
    expect(BASE_TOKENS.font).toMatch(/^ui-sans-serif, system-ui/);
  });

  it("FR-008: shows focus, respects reduced motion, and keeps touch targets 44px tall", () => {
    expect(WIZARD_CSS).toMatch(/:focus-visible \{[^}]*outline: 3px solid var\(--focus\)/);
    expect(WIZARD_CSS).toContain("@media (prefers-reduced-motion: no-preference)");
    expect(WIZARD_CSS).toMatch(/button, a\.button \{[^}]*min-height: 2\.75rem/);
    expect(WIZARD_CSS).toMatch(/input\[type=text\], input\[type=password\], textarea \{[^}]*min-height: 2\.75rem/);
    expect(WIZARD_CSS).toMatch(/\.question h2 \{[^}]*font-size: var\(--text-xl\)/);
    expect(WIZARD_CSS).not.toMatch(/text-transform:\s*uppercase/);
  });

  it("works in a narrow window: the rail becomes a row and button rows stack", () => {
    expect(WIZARD_CSS).toContain("@media (max-width: 51.99rem)");
    expect(WIZARD_CSS).toContain("@media (max-width: 30rem)");
    expect(WIZARD_CSS).toContain(".layout > * { min-width: 0; }");
  });

  it("defines every class the page may use", () => {
    for (const name of PAGE_CLASSES) expect({ name, defined: new RegExp(`\\.${name}(?![a-z0-9-])`).test(WIZARD_CSS) }).toEqual({ name, defined: true });
  });

  it("spec 048 phase 2: styles the settings screen's recommended, advanced, group and field-link classes", () => {
    for (const name of ["recommended", "advanced", "group", "field-link"]) {
      expect(PAGE_CLASSES).toContain(name);
      expect(WIZARD_CSS).toMatch(new RegExp(`\\.${name}[\\s{.,:]`));
    }
  });

  it("is the stylesheet the server sends", () => {
    expect(SERVED_CSS).toBe(WIZARD_CSS);
  });
});
