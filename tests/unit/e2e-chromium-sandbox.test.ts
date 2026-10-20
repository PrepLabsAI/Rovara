import { describe, expect, it } from "vitest";
import { ChromiumSandboxAttestationSchema, evaluateChromiumSandbox } from "../../packages/contracts/src/index.js";

const runId = "7f1d1c6e-4f43-4d5c-9b8f-2a6f3c0a9d11";
const browser = { pid: 40, nsPidDepth: 1, seccompFilters: 1, uidMap: "0 0 4294967295" };
const sandboxedRenderer = { pid: 77, nsPidDepth: 2, seccompFilters: 2, uidMap: "0 1000 1" };
const attestation = (overrides: Record<string, unknown> = {}) => ChromiumSandboxAttestationSchema.parse({ schemaVersion: "e2e-executor-chromium-sandbox/v1", runId,
  groupId: "group-1", browser, renderers: [sandboxedRenderer], ...overrides });

describe("chromium sandbox attestation", () => {
  it("accepts renderers that sit behind their own seccomp filter, PID namespace and user namespace", () => {
    expect(evaluateChromiumSandbox(attestation())).toEqual({ sandboxed: true });
    expect(evaluateChromiumSandbox(attestation({ renderers: [sandboxedRenderer, { ...sandboxedRenderer, pid: 78 }] }))).toEqual({ sandboxed: true });
  });

  it("refuses a run in which no renderer was observed, since nothing was shown to be sandboxed", () => {
    expect(evaluateChromiumSandbox(attestation({ renderers: [] }))).toEqual({ sandboxed: false, reason: "no-renderer-observed" });
  });

  it("refuses a --no-sandbox browser: its renderer is an ordinary child with the browser's own filters and namespaces", () => {
    const plain = { pid: 77, nsPidDepth: 1, seccompFilters: 1, uidMap: browser.uidMap };
    expect(evaluateChromiumSandbox(attestation({ renderers: [plain] }))).toMatchObject({ sandboxed: false });
  });

  it.each([
    ["seccomp", { seccompFilters: 1 }, "renderer-has-no-extra-seccomp-filter"],
    ["pid namespace", { nsPidDepth: 1 }, "renderer-shares-pid-namespace"],
    ["user namespace", { uidMap: "0 0 4294967295" }, "renderer-shares-user-namespace"],
  ])("refuses when one renderer lacks its own %s, even if another has it", (_label, weakness, reason) => {
    expect(evaluateChromiumSandbox(attestation({ renderers: [sandboxedRenderer, { ...sandboxedRenderer, pid: 78, ...weakness }] }))).toEqual({ sandboxed: false, reason });
  });

  it("refuses a renderer list that names the browser itself or repeats a process", () => {
    expect(evaluateChromiumSandbox(attestation({ renderers: [{ ...sandboxedRenderer, pid: browser.pid }] }))).toMatchObject({ sandboxed: false });
    expect(evaluateChromiumSandbox(attestation({ renderers: [sandboxedRenderer, sandboxedRenderer] }))).toMatchObject({ sandboxed: false });
  });

  it("is strict about its shape", () => {
    expect(ChromiumSandboxAttestationSchema.safeParse({ ...attestation(), sandboxed: true }).success).toBe(false);
    expect(ChromiumSandboxAttestationSchema.safeParse({ ...attestation(), runId: "not-a-uuid" }).success).toBe(false);
  });
});
