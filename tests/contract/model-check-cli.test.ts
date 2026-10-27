import { describe, expect, it, vi } from "vitest";
import { discoverModelCheck, drivingTestCostLine, formatTiers, testModelCheck, type ModelCheckInput } from "../../packages/cli/src/setup/model-check.js";
import { scriptedPrompter } from "../support/init-fakes.js";

// M1.4 Task 4.10C: `agentx project model-check discover | test`, against a fake control plane.

const session = { controlPlaneUrl: "https://cp.example.test", accessToken: "admin-token" };
const MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const tiers = {
  discovery: { status: "listed", checkedAt: "2026-10-23T10:00:00.000Z" }, why: "default-not-usable",
  recommended: { modelId: MODEL, label: "Claude Haiku 4.5 (US)", scope: "geographic", worstCaseUsd: 0.0565 },
  current: { modelId: "us.anthropic.claude-haiku-5-5", label: "Claude Haiku 5.5 (US)", scope: "geographic", worstCaseUsd: 0.0057 },
  worksOnAccount: [{ modelId: "global.anthropic.claude-haiku-4-5-20251001-v1:0", label: "x", scope: "global", testedAt: "2026-10-22T09:00:00.000Z", payloadShape: "minimal" }],
  notUsable: [{ modelId: "us.anthropic.claude-haiku-5-5", label: "x", scope: "geographic", reason: "this account's limit for the model is zero; US-only `L-47520EB7` 0, Global `L-F26CA8D1` 0 tokens per minute" }],
  canBeTested: [{ modelId: "global.anthropic.claude-haiku-5-5", label: "x", scope: "global", worstCaseUsd: 0.0051 }], canBeTestedMore: 3,
};

function plane(answers: Array<Record<string, unknown> | { status: number; body: unknown }>) {
  const requests: Array<{ method: string; path: string; body: unknown; auth: string | null }> = [];
  const queue = [...answers];
  const fetchFake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
    requests.push({ method: init?.method ?? "GET", path, body: init?.body === undefined ? undefined : JSON.parse(init.body as string), auth: new Headers(init?.headers).get("authorization") });
    const next = queue.shift() ?? {};
    const failure = "status" in next && "body" in next && typeof (next as { status: unknown }).status === "number";
    return new Response(JSON.stringify(failure ? (next as { body: unknown }).body : next), { status: failure ? (next as { status: number }).status : 200, headers: { "content-type": "application/json" } });
  });
  let clock = 0;
  const lines: string[] = [];
  const input: ModelCheckInput = { env: "agentxlivetest123", session, fetch: fetchFake, write: (line) => lines.push(line), sleep: async (ms) => { clock += ms; }, now: () => clock };
  return { requests, lines, input, clock: () => clock };
}

describe("discover", () => {
  it("asks the runner for a discovery, waits for it, and prints the tiers with the exact commands", async () => {
    const p = plane([{ checkId: "c1" }, { status: "pending" }, { status: "discovered", checkId: "c1", sentence: "ok", tiers }]);
    const result = await discoverModelCheck(p.input);
    expect(result.fresh).toBe(true);
    expect(p.requests.map((request) => [request.method, request.path])).toEqual([["POST", "/v1/admin/e2e/model-checks"], ["GET", "/v1/admin/e2e/model-checks/c1"], ["GET", "/v1/admin/e2e/model-checks/c1"]]);
    expect(p.requests[0]!.body).toEqual({ kind: "discover" });
    expect(p.requests.every((request) => request.auth === "Bearer admin-token")).toBe(true);
    const text = p.lines.join("\n");
    expect(text).toContain(`Recommended: \`${MODEL}\` (Claude Haiku 4.5 (US)), not tested yet (worst case of one driving test $0.0565) (Rovara's own default is not usable on this account)`);
    expect(text).toContain("`global.anthropic.claude-haiku-4-5-20251001-v1:0`, driving test passed 2026-10-22, with the minimal request shape");
    expect(text).toContain("`us.anthropic.claude-haiku-5-5`: this account's limit for the model is zero; US-only `L-47520EB7` 0, Global `L-F26CA8D1` 0");
    expect(text).toContain("`global.anthropic.claude-haiku-5-5`  $0.0051");
    expect(text).toContain("and 3 more");
    expect(text).toContain(`agentx --env agentxlivetest123 project model-check test --model ${MODEL}`);
    expect(text).toContain(`agentx --env agentxlivetest123 config set models.e2eAgent ${MODEL}`);
  });

  it("falls back to the tiers on record, and says why, when the runner cannot be asked", async () => {
    const p = plane([{ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "no-model-check-runner: the READY runtime's runner is not recorded" } } }, { tiers }]);
    const result = await discoverModelCheck(p.input);
    expect(result.fresh).toBe(false);
    expect(p.lines.join("\n")).toMatch(/Could not ask the runner: .*no-model-check-runner/);
    expect(p.lines.join("\n")).toContain("Recommended:");
  });

  it("says when no model is recommended because the account's quotas could not be read, and marks the models it could not check (I-3)", () => {
    const unreadable = { ...tiers, why: "quota-unreadable", recommended: null, worksOnAccount: [], notUsable: [], canBeTestedMore: 0,
      canBeTested: [{ modelId: "us.anthropic.claude-haiku-5-5", label: "x", scope: "geographic", worstCaseUsd: 0.0056, quotaUnreadable: true }] };
    const text = formatTiers(unreadable, "e").join("\n");
    expect(text).toContain("Recommended: none yet: Rovara could not read this account's quota for Rovara's default model or any other, so no model is known to be usable. Test one to find out.");
    expect(text).toContain("`us.anthropic.claude-haiku-5-5`  $0.0056 (could not read this account's quota)");
    expect(text).not.toContain("To choose it:");
    // A recommendation next to an unreadable default says so.
    const other = formatTiers({ ...tiers, why: "quota-unreadable" }, "e").join("\n");
    expect(other).toContain("(could not read this account's quota for Rovara's default model)");
  });

  it("shows an unverified discovery as the sentence the driving test will confirm, and no control characters from the control plane", async () => {
    const unverified = { ...tiers, discovery: { status: "unverified", unverifiedReason: "access-denied" }, why: "discovery-unverified", notUsable: [], canBeTested: [], worksOnAccount: [] };
    const text = formatTiers({ ...unverified, recommended: { ...tiers.recommended, modelId: "us.model\u001b[31m" } }, "e").join("\n");
    expect(text).toContain("Rovara could not list your models (access-denied); the driving test will confirm a model.");
    expect(text).not.toContain("\u001b");
  });
});

describe("test", () => {
  it("shows the worst-case cost, asks, runs the driving test, and prints the sentence", async () => {
    const p = plane([{ checkId: "c2" }, { status: "passed", checkId: "c2", sentence: "The driving test passed with `m`: ...", drive: { modelId: MODEL, payloadShape: "standard", calls: 3, inputTokens: 4000, outputTokens: 300 } }]);
    const prompter = scriptedPrompter([true]);
    const view = await testModelCheck({ ...p.input, prompter, model: MODEL });
    expect(view.status).toBe("passed");
    expect(p.lines[0]).toContain("worst case $0.0565");
    expect(prompter.asked[0]).toContain(`Run the driving test of ${MODEL}`);
    expect(p.requests[0]!.body).toEqual({ kind: "drive", modelId: MODEL });
    expect(p.lines.join("\n")).toContain(`agentx --env agentxlivetest123 config set models.e2eAgent ${MODEL}`);
  });

  it("with no --model it drives the installation's own model, whose cost the control plane's tiers give", async () => {
    const p = plane([{ tiers }, { checkId: "c3" }, { status: "failed", checkId: "c3", sentence: "Amazon Bedrock refused ..." }]);
    const view = await testModelCheck({ ...p.input, prompter: scriptedPrompter([true]) });
    expect(view.status).toBe("failed");
    expect(p.requests[1]!.body).toEqual({ kind: "drive" });
    expect(p.lines.join("\n")).toContain("Amazon Bedrock refused ...");
  });

  it("does nothing when the administrator declines, and --yes skips the question", async () => {
    const declined = plane([]);
    await expect(testModelCheck({ ...declined.input, prompter: scriptedPrompter([false]), model: MODEL })).rejects.toThrow(/was not run/);
    expect(declined.requests).toEqual([]);
    const yes = plane([{ checkId: "c4" }, { status: "passed", checkId: "c4", sentence: "ok", drive: { modelId: MODEL, payloadShape: "standard", calls: 3, inputTokens: 1, outputTokens: 1 } }]);
    const prompter = scriptedPrompter([]);
    await testModelCheck({ ...yes.input, prompter, model: MODEL, assumeYes: true });
    expect(prompter.asked).toEqual([]);
    expect(yes.requests).toHaveLength(2);
  });

  it("gives up after ten minutes without an answer", async () => {
    const p = plane([{ checkId: "c5" }, ...Array.from({ length: 80 }, () => ({ status: "pending" }))]);
    await expect(testModelCheck({ ...p.input, prompter: scriptedPrompter([]), model: MODEL, assumeYes: true })).rejects.toThrow(/did not answer within 10 minutes\. It may be busy, or gone, or it may be missing a permission on the artifacts bucket: reading the check request \(s3:GetObject\) or writing its result \(s3:PutObject\)\. Check the runner's status.*ask again/);
    expect(p.clock()).toBeGreaterThanOrEqual(10 * 60_000);
    expect(p.clock()).toBeLessThan(11 * 60_000);
  });

  it("refuses a --model that is not a model id before asking the control plane", async () => {
    const p = plane([]);
    await expect(testModelCheck({ ...p.input, prompter: scriptedPrompter([]), model: "a b;c" })).rejects.toThrow(/not a model id/);
    expect(p.requests).toEqual([]);
  });

  it("prints a worst-case cost line from the pinned prices, and says so when the model is not in the table", () => {
    expect(drivingTestCostLine(MODEL)).toBe(`A driving test of \`${MODEL}\` makes at most 6 model calls, 36,000 input tokens and 512 output tokens per call: worst case $0.0565 on this account (it usually costs about a tenth of that).`);
    expect(drivingTestCostLine("no-such-model")).toContain("its price depends on the model");
  });
});
