// TE-F2 part B: the failure-pack runner. One run per mode through an injected runner; "handled", "not handled" or "not run" per mode; never "proven"; never counts.
import { describe, expect, it } from "vitest";
import { FAILURE_MODES, replyCountsTowardProof } from "../../packages/contracts/src/index.js";
import { runModelFailurePack } from "../../packages/worker/src/model-failure-run.js";

describe("failure-pack runner", () => {
  it("runs the command once per mode and says handled, not handled or not run", async () => {
    const seen: string[] = [];
    const result = await runModelFailurePack({
      run: (mode) => {
        seen.push(mode);
        if (mode === "rate_limit") return Promise.resolve({ exitCode: 0, timedOut: false });
        if (mode === "cut_off_stream") return Promise.resolve({ exitCode: 1, timedOut: false });
        if (mode === "token_limit") return Promise.resolve({ exitCode: null, timedOut: true });
        return Promise.reject(new Error("boom"));
      },
    });
    expect(seen).toEqual([...FAILURE_MODES]);
    expect(result.outcomes.map((entry) => entry.outcome)).toEqual(["handled", "not_handled", "not_run", "not_run", "not_run"]);
    expect(result.lines).toContain("failure pack, rate limit: handled");
    expect(result.lines).toContain("failure pack, cut off stream: not handled");
    expect(result.lines.join("\n")).not.toMatch(/proven|\bReal\b/iu);
    expect(result.countsTowardProof).toBe(false);
    expect(replyCountsTowardProof("failure_pack")).toBe(false);
  });
  it("a stopped run reports every remaining mode as not run", async () => {
    const stop = new AbortController();
    stop.abort();
    const result = await runModelFailurePack({ modes: ["rate_limit", "refusal"], signal: stop.signal, run: () => Promise.resolve({ exitCode: 0, timedOut: false }) });
    expect(result.outcomes.map((entry) => entry.outcome)).toEqual(["not_run", "not_run"]);
  });
});
