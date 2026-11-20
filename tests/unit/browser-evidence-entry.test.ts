// TE-H1 slice 2: the capture program that runs in the executor image. It reads one plan, waits for the app the worker started in the sandbox, takes each page through the slice-1 driver, and prints bounded lines. Tested here with a
// fake driver (the real Chromium runs in the Linux test); what it must never do is print something the worker would have to guess about.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BROWSER_EVIDENCE_EXECUTOR_OUTPUT_MAX_BYTES, type BrowserEvidenceExecutorPlan } from "../../packages/contracts/src/index.js";
import { runCapture, type CaptureDeps } from "../../packages/verifier/src/executor/browser-evidence-entry.js";

const plan = (over: Partial<BrowserEvidenceExecutorPlan> = {}): BrowserEvidenceExecutorPlan => ({ port: 4321, readyPath: "/health", routes: ["/a", "/b"], maskSelectors: [".account"], runMs: 30_000, pageMs: 15_000, ...over });
const jpeg = (size = 500, seed = 1) => { const bytes = new Uint8Array(size); bytes.set([0xff, 0xd8, 0xff]); bytes.fill(seed, 3); return bytes; };
type Capture = CaptureDeps["driver"]["capture"];
const deps = (capture: Capture, ready: "ready" | "app_did_not_start" | "time_limit" = "ready", now?: () => number): CaptureDeps & { asked: Array<{ route: string; masks: readonly string[]; timeoutMs: number }>; waited: Array<{ port: number; readyPath: string }> } => {
  const asked: Array<{ route: string; masks: readonly string[]; timeoutMs: number }> = [];
  const waited: Array<{ port: number; readyPath: string }> = [];
  return { asked, waited, waitReady: async (input) => { waited.push({ port: input.port, readyPath: input.readyPath }); return ready; },
    driver: { capture: async (side, route, options) => { asked.push({ route, masks: options.maskSelectors, timeoutMs: options.timeoutMs }); return capture(side, route, options); } }, ...(now === undefined ? {} : { now }) };
};

describe("the capture program", () => {
  it("prints only the app's state when the app is not ready, and takes no page", async () => {
    for (const status of ["app_did_not_start", "time_limit"] as const) {
      const d = deps(async () => ({ ok: true, bytes: jpeg(), consoleErrors: 0 }), status);
      expect(await runCapture(plan(), d)).toEqual([{ t: "app", status }]);
      expect(d.asked).toEqual([]);
    }
  });
  it("holds a picture over the e2e cap to a failed capture (the line must fit its schema), and never prints more than its output bound", async () => {
    const over = await runCapture(plan({ routes: ["/a"] }), deps(async () => ({ ok: true, bytes: jpeg(700_000), consoleErrors: 0 })));
    expect(over[1]).toEqual({ t: "shot", route: "/a", ok: false, reason: "capture_failed" });
    // Five pictures at the cap fit; the bound is on what is printed in all.
    const many = await runCapture(plan({ routes: ["/a", "/b", "/c", "/d", "/e"] }), deps(async () => ({ ok: true, bytes: jpeg(512 * 1024, 7), consoleErrors: 0 })));
    const printed = many.map((line) => Buffer.byteLength(JSON.stringify(line)) + 1).reduce((sum, size) => sum + size, 0);
    expect(printed).toBeLessThanOrEqual(BROWSER_EVIDENCE_EXECUTOR_OUTPUT_MAX_BYTES);
    expect(many.filter((line) => line.t === "shot" && line.ok)).toHaveLength(5);
  });
});

describe("the capture program's browser", () => {
  const source = readFileSync("packages/verifier/src/executor/browser-evidence-entry.ts", "utf8");
  it("is driven over a pipe, never a DevTools port: the program shares the sandbox's network namespace, and a debugging port there would hand the browser to whatever runs in the sandbox", () => {
    const code = source.split("\n").filter((row) => !row.trimStart().startsWith("//") && !row.trimStart().startsWith("*") && !row.trimStart().startsWith("/*")).join("\n");
    expect(code).toContain("chromium.launch(");
    expect(code).toContain("chromiumSandbox: true");
    for (const forbidden of ["remote-debugging-port", "remote-debugging-address", "connectOverCDP", "launchLocalChromium", "openEvidenceChromium", "--no-sandbox"]) expect(code, forbidden).not.toContain(forbidden);
  });
});

// TE-H1 slice 3: an app behind a login. The program signs in ONCE, after the app is up and before any page; a sign-in that did not work is its only line after the app's own (no page of a signed-out app is taken); the values come
// in one environment variable that the program reads once and removes, and a plan with a sign-in but no values (or values but no plan) is refused before any browser starts.
describe("the capture program with a sign-in", () => {
  const SIGN_IN = { path: "/login", usernameSelector: "#email", passwordSelector: "#password", submitSelector: "button", successPath: "/dashboard" } as const;
  const signed = (result: "ok" | "sign_in_failed" | "time_limit" | "throws" | "missing") => {
    const order: string[] = [];
    const base = deps(async () => { order.push("capture"); return { ok: true, bytes: jpeg(), consoleErrors: 0 }; });
    const timeouts: number[] = [];
    const driver = { ...base.driver, ...(result === "missing" ? {} : { signIn: async (options: { timeoutMs: number }) => { order.push("signIn"); timeouts.push(options.timeoutMs); if (result === "throws") throw new Error("Invalid password for tester"); return result; } }) };
    return { order, timeouts, deps: { ...base, driver } as CaptureDeps };
  };

  it("says the sign-in did not work, and takes no page, for a failure, a throw (never its words) or a driver that cannot sign in (mutant: pages taken after a failed sign-in)", async () => {
    for (const result of ["sign_in_failed", "throws", "missing"] as const) {
      const w = signed(result);
      const lines = await runCapture(plan({ signIn: SIGN_IN }), w.deps);
      expect(lines, result).toEqual([{ t: "app", status: "sign_in_failed" }]);
      expect(w.order).not.toContain("capture");
      expect(JSON.stringify(lines)).not.toContain("tester");
    }
    expect(await runCapture(plan({ signIn: SIGN_IN }), signed("time_limit").deps)).toEqual([{ t: "app", status: "time_limit" }]);
  });

  it("reads the values once from one environment variable and removes it, and refuses a plan and values that do not go together, before any browser starts", () => {
    const source = readFileSync("packages/verifier/src/executor/browser-evidence-entry.ts", "utf8").split("\n").filter((row) => !row.trimStart().startsWith("//") && !row.trimStart().startsWith("*")).join("\n");
    expect(source).toContain("process.env[BROWSER_EVIDENCE_SIGN_IN_ENV]");
    expect(source).toContain("delete process.env[BROWSER_EVIDENCE_SIGN_IN_ENV]");
    expect(source.indexOf("delete process.env[BROWSER_EVIDENCE_SIGN_IN_ENV]")).toBeLessThan(source.indexOf("await openPipeChromium()"));
    expect(source).toContain("(plan.signIn === undefined) !== (raw === undefined)");
    // Chromium has its own environment, so a value in this program's environment never reaches it.
    expect(source).toMatch(/env: \{ PATH: process\.env\["PATH"\]/u);
    // The program prints lines from the schema only: no value is ever part of one.
    expect(source).not.toMatch(/stdout\.write\([^)]*(values|raw|password|username)/u);
  });
});
