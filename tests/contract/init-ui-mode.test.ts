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

  it("--ui is always the page, and --no-ui always the terminal", () => {
    expect(resolveUiMode({ ...base, ui: true, interactive: false, browser: false })).toEqual({ mode: "page" });
    expect(resolveUiMode({ ...base, ui: false })).toEqual({ mode: "terminal" });
  });

  it("Review Focus 5: --yes is the terminal, whatever else holds", () => {
    expect(resolveUiMode({ ...base, yes: true })).toEqual({ mode: "terminal" });
  });

  it("an injected prompter (a test, or a caller with its own) is the terminal unless --ui is given", () => {
    expect(resolveUiMode({ ...base, injectedPrompter: true })).toEqual({ mode: "terminal" });
    expect(resolveUiMode({ ...base, injectedPrompter: true, ui: true })).toEqual({ mode: "page" });
  });

  it("no terminal is the terminal path (which then refuses, as before, without --yes)", () => {
    expect(resolveUiMode({ ...base, interactive: false })).toEqual({ mode: "terminal" });
  });

  it("no browser is the terminal, marked so init says how to get the page", () => {
    expect(resolveUiMode({ ...base, browser: false })).toEqual({ mode: "terminal", noBrowser: true });
  });
});

describe("whether this machine can open a browser", () => {
  it("macOS can", () => {
    expect(browserAvailable({ platform: "darwin", env: {} })).toBe(true);
  });

  it("Review Focus 1: an SSH session never opens a page by default, even on macOS", () => {
    expect(browserAvailable({ platform: "darwin", env: { SSH_CONNECTION: "10.0.0.2 51000 10.0.0.1 22" } })).toBe(false);
    expect(browserAvailable({ platform: "linux", env: { SSH_TTY: "/dev/pts/0", DISPLAY: ":0" } })).toBe(false);
  });

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
