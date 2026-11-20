// tests/contract/init-ui-mode.test.ts
// FR-001 (Q1, Q2, Q12): with neither --ui nor --no-ui, agentx init uses the install page in an
// interactive terminal on a machine that can open a browser, and the terminal everywhere else.
import { describe, expect, it } from "vitest";
import { browserAvailable, resolveUiMode } from "../../packages/cli/src/init/ui-mode.js";

const base = { ui: undefined, yes: false, injectedPrompter: false, interactive: true, browser: true };

describe("which way agentx init asks", () => {
  it("the page by default in an interactive terminal that can open a browser", () => {
    expect(resolveUiMode(base)).toEqual({ mode: "page" });
  });

});

describe("whether this machine can open a browser", () => {

  it("Review Focus 2: Linux needs a display", () => {
    expect(browserAvailable({ platform: "linux", env: {} })).toBe(false);
    expect(browserAvailable({ platform: "linux", env: { DISPLAY: ":0" } })).toBe(true);
    expect(browserAvailable({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } })).toBe(true);
  });

  it("CloudShell and CI cannot", () => {
    expect(browserAvailable({ platform: "linux", env: { AWS_EXECUTION_ENV: "CloudShell", DISPLAY: ":0" } })).toBe(false);
    expect(browserAvailable({ platform: "darwin", env: { CI: "true" } })).toBe(false);
    expect(browserAvailable({ platform: "darwin", env: { CI: "false" } })).toBe(true);
  });

  it("Q12: Windows stays on the terminal by default", () => {
    expect(browserAvailable({ platform: "win32", env: {} })).toBe(false);
  });
});
