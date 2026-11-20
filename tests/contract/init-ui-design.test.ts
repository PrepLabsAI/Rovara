// Owner request of 2026-10-01 and spec 048 FR-001 and FR-008: the installer's design system. One
// stylesheet from 127.0.0.1 with no external asset, light and dark, readable contrast, visible
// focus, and every class the page uses defined.
import { describe, expect, it } from "vitest";
import { BASE_TOKENS, COLOR_TOKENS, WIZARD_CSS } from "../../packages/cli/src/init/ui/design.js";


describe("the installer's design system", () => {

  it("has the same tokens in both modes, all of them in the stylesheet", () => {
    expect(Object.keys(COLOR_TOKENS.dark).sort()).toEqual(Object.keys(COLOR_TOKENS.light).sort());
    for (const name of [...Object.keys(COLOR_TOKENS.light), ...Object.keys(BASE_TOKENS)]) expect(WIZARD_CSS).toContain(`--${name}: `);
    expect(WIZARD_CSS).toContain("@media (prefers-color-scheme: dark)");
  });

});
