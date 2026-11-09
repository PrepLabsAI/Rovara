// Saved project images (SV wiring): a preparation that fell back from its image tells the broker the step, with its own grant; it never holds the preparation up and never throws.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrepareSavedEnvSchema, savedEnvRepositoryName } from "../../packages/contracts/src/index.js";
import { createSavedEnvFallbackReporter } from "../../packages/worker/src/saved-env/login.js";
import { savedEnvOptionsOf } from "../../packages/worker/src/saved-env/use.js";

afterEach(() => { vi.restoreAllMocks(); });
const invocation = { kind: "prepare", workspaceId: "ws-1", operationId: "op-1", payload: { repositoryGrant: "grant-1" } } as never;
const payload = PrepareSavedEnvSchema.parse({ repository: savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "proj-1" }), digest: `sha256:${"d".repeat(64)}`, testEnvRevision: 4, environmentKey: "a".repeat(64), taskTestEnvRevision: 4 });

describe("the fallback report", () => {
  it("POSTs the step, and only the step, to the preparation's own operation with its grant", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await createSavedEnvFallbackReporter({ controlPlaneUrl: "https://cp.example.test/", invocation, fetchImplementation: async (url, init) => { calls.push({ url: typeof url === "string" ? url : "unexpected", init: init! }); return new Response("{}", { status: 200 }); } })("extract");
    expect(calls[0]!.url).toBe("https://cp.example.test/v1/internal/workspaces/ws-1/operations/op-1/saved-env-fallback");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["x-agentx-repository-grant"]).toBe("grant-1");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ step: "extract" });
  });

  it("never throws: an unreachable or refusing broker changes nothing", async () => {
    for (const fetchImplementation of [async () => { throw new Error("down"); }, async () => new Response("no", { status: 500 })] as Array<typeof fetch>) {
      await expect(createSavedEnvFallbackReporter({ controlPlaneUrl: "https://cp.example.test", invocation, fetchImplementation })("pull")).resolves.toBeUndefined();
    }
  });

  it("is called by the preparation's fallback, once per fallback, with the step; without a reporter the fallback is the log line alone", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const steps: string[] = [];
    const options = savedEnvOptionsOf(payload, async () => { throw new Error("unused"); }, undefined, async (step) => { steps.push(step); });
    options.onFallback?.("manifest");
    expect(steps).toEqual(["manifest"]);
    expect(() => savedEnvOptionsOf(payload, async () => { throw new Error("unused"); }).onFallback?.("pull")).not.toThrow();
  });

  it("does not wait for a report that fails: a rejecting reporter is not an unhandled rejection of the preparation", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const options = savedEnvOptionsOf(payload, async () => { throw new Error("unused"); }, undefined, createSavedEnvFallbackReporter({ controlPlaneUrl: "https://cp.example.test", invocation, fetchImplementation: async () => { throw new Error("down"); } }));
    expect(() => options.onFallback?.("pull")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
