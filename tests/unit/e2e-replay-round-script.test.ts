import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseReplayArgs, runReplayRound, viewOfRecord, type CliResult, type ReplayDependencies } from "../../scripts/e2e-replay-round.js";

// M1.4 Task 4.6b, test 22: scripts/e2e-replay-round.ts starts the replay, polls and prints the record, and never calls a route that could change a verdict.

const TASK = "44444444-4444-4444-8444-444444444444";
const ROUND = "55555555-5555-4555-8555-555555555555";
const ARGS = ["--env", "agentxlivetest123", "--task", TASK, "--round", ROUND];
const ok = (body: unknown): CliResult => ({ status: 0, stdout: JSON.stringify(body), stderr: "" });
function fakeDependencies(answers: { start: CliResult; show: CliResult[] }) {
  const calls: string[][] = []; const out: string[] = []; const err: string[] = []; const slept: number[] = [];
  let at = 0; let shown = 0;
  const dependencies: ReplayDependencies = {
    cli: (list) => { calls.push([...list]); return list[3] === "start" ? answers.start : answers.show[Math.min(shown++, answers.show.length - 1)]!; },
    sleep: async (ms) => { slept.push(ms); at += ms; }, now: () => at, out: (text) => out.push(text), err: (text) => err.push(text),
  };
  return { dependencies, calls, out, err, slept };
}
const recorded = { attempt: 1, state: "RECORDED", requestedAt: "t0", startedAt: "t1", recordedAt: "t2", replay: { status: "PASS", reproduced: true, downloadSha256Match: true } };

describe("the arguments", () => {
  it("need an environment, a task and a round that are what they say, and refuse anything else", () => {
    expect(parseReplayArgs(ARGS)).toMatchObject({ env: "agentxlivetest123", task: TASK, round: ROUND, pollSeconds: 15, timeoutMinutes: 40, wait: true });
    expect(parseReplayArgs([...ARGS, "--no-wait", "--poll-seconds", "5", "--timeout-minutes", "10", "--profile", "p", "--region", "us-east-1"])).toMatchObject({ wait: false, pollSeconds: 5, timeoutMinutes: 10, profile: "p", region: "us-east-1" });
    for (const bad of [["--env", "x"], ["--task", TASK, "--round", ROUND], [...ARGS, "--force"], [...ARGS, "--task", TASK], ["--env", "AgentX!", "--task", TASK, "--round", ROUND],
      ["--env", "agentxlivetest123", "--task", "nope", "--round", ROUND], [...ARGS, "--poll-seconds", "0"], [...ARGS, "--timeout-minutes", "1000"]]) {
      expect(() => parseReplayArgs(bad), bad.join(" ")).toThrow();
    }
  });
});

describe("the run", () => {
  it("starts the replay once, polls its record until it is recorded, prints the record's own fields and exits 0", async () => {
    const f = fakeDependencies({ start: ok({ replay: { sourceRoundId: ROUND, attempt: 1, state: "STARTED", operationId: "must-not-be-echoed" } }),
      show: [ok({ replays: [{ attempt: 1, state: "STARTED", requestedAt: "t0" }] }), ok({ replays: [{ attempt: 1, state: "STARTED", requestedAt: "t0" }] }), ok({ replays: [recorded] })] });
    expect(await runReplayRound(parseReplayArgs(ARGS), f.dependencies)).toBe(0);
    expect(f.calls.filter((call) => call[3] === "start")).toHaveLength(1);
    expect(f.calls.filter((call) => call[3] === "show")).toHaveLength(3);
    expect(f.slept).toEqual([15_000, 15_000]);
    expect(JSON.parse(f.out[0]!)).toEqual(recorded);
    expect(f.out.join("\n") + f.err.join("\n")).not.toContain("must-not-be-echoed");
  });

  it("test 22: every call it makes is `admin task e2e-replay start|show` with the task and the round: no retry, cancel, decision, publish or send-back, and no other route", async () => {
    const f = fakeDependencies({ start: ok({ replay: { attempt: 1 } }), show: [ok({ replays: [recorded] })] });
    await runReplayRound(parseReplayArgs(ARGS), f.dependencies);
    for (const call of f.calls) {
      expect(call.slice(0, 3)).toEqual(["admin", "task", "e2e-replay"]);
      expect(["start", "show"]).toContain(call[3]);
      expect(call.slice(4)).toEqual(["--task", TASK, "--round", ROUND]);
    }
    // And nothing in the source reaches for another command or route.
    const source = readFileSync(new URL("../../scripts/e2e-replay-round.ts", import.meta.url), "utf8");
    expect(source.match(/"admin", "task", "e2e-replay", "(start|show)"/g)).toHaveLength(2);
    expect(source).not.toMatch(/"(retry|cancel|decision|publish)"|workflow\/|\bfetch\(/u);
  });

  it("exits 1 for a replay that could not be run, and prints its record", async () => {
    const f = fakeDependencies({ start: ok({ replay: { attempt: 2 } }), show: [ok({ replays: [{ attempt: 1, state: "RECORDED" }, { attempt: 2, state: "UNAVAILABLE", reason: "run-failed", requestedAt: "t0" }] })] });
    expect(await runReplayRound(parseReplayArgs(ARGS), f.dependencies)).toBe(1);
    expect(JSON.parse(f.out[0]!)).toMatchObject({ attempt: 2, state: "UNAVAILABLE", reason: "run-failed" });
  });

  it("gives up with exit 1 and says how to read it later when the record does not settle in time", async () => {
    const f = fakeDependencies({ start: ok({ replay: { attempt: 1 } }), show: [ok({ replays: [{ attempt: 1, state: "STARTED" }] })] });
    expect(await runReplayRound(parseReplayArgs([...ARGS, "--timeout-minutes", "1", "--poll-seconds", "20"]), f.dependencies)).toBe(1);
    expect(f.err.join("\n")).toContain("did not finish within 1 minutes");
    expect(f.err.join("\n")).toContain("e2e-replay show");
  });

  it("with --no-wait reads the record once and exits 0", async () => {
    const f = fakeDependencies({ start: ok({ replay: { attempt: 1 } }), show: [ok({ replays: [{ attempt: 1, state: "STARTED", requestedAt: "t0" }] })] });
    expect(await runReplayRound(parseReplayArgs([...ARGS, "--no-wait"]), f.dependencies)).toBe(0);
    expect(f.calls.filter((call) => call[3] === "show")).toHaveLength(1);
    expect(f.slept).toEqual([]);
  });

  it("exits 2 with the broker's own sentence when the request is refused, and polls nothing", async () => {
    const f = fakeDependencies({ start: { status: 1, stdout: JSON.stringify({ error: { code: "CONFIG_INVALID", message: "replay-no-recording: the qualified round left no recording to replay" } }), stderr: "" }, show: [] });
    expect(await runReplayRound(parseReplayArgs(ARGS), f.dependencies)).toBe(2);
    expect(f.err.join("\n")).toContain("replay-no-recording");
    expect(f.calls.every((call) => call[3] === "start")).toBe(true);
  });

  it("shows only the record's fields, not an operation, round or admission id", () => {
    expect(viewOfRecord({ ...recorded, operationId: "op", roundId: "r", admissionSha256: "a" })).toEqual(recorded);
  });
});

describe("agentx admin task e2e-replay", () => {
  it("posts the round with the admin token to the task's replay route, reads the attempts with a GET, and reports the broker's refusal with its own code", async () => {
    const { startTaskE2EReplay, showTaskE2EReplays } = await import("../../packages/cli/src/admin/task-e2e-replay.js");
    const post = vi.fn(async () => Response.json({ replay: { attempt: 1 } }, { status: 202 }));
    await startTaskE2EReplay({ controlPlaneUrl: "https://agentx.example.test/", accessToken: "admin-token", taskId: TASK, roundId: ROUND }, post as unknown as typeof fetch);
    const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://agentx.example.test/v1/admin/tasks/${TASK}/e2e-replay`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer admin-token" });
    expect(JSON.parse(init.body as string)).toEqual({ roundId: ROUND });
    const get = vi.fn(async () => Response.json({ replays: [] }));
    await showTaskE2EReplays({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t", taskId: TASK, roundId: ROUND }, get as unknown as typeof fetch);
    expect((get.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe(`https://agentx.example.test/v1/admin/tasks/${TASK}/e2e-replay?roundId=${ROUND}`);
    expect((get.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("GET");
    const refused = vi.fn(async () => Response.json({ error: { code: "CONFIG_INVALID", message: "replay-no-recording: the qualified round left no recording to replay" } }, { status: 400 }));
    await expect(startTaskE2EReplay({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t", taskId: TASK, roundId: ROUND }, refused as unknown as typeof fetch)).rejects.toThrow(/replay-no-recording/);
  });
  it("refuses a --task or --round that is not an ID before signing in or calling AgentX", async () => {
    const { executeCli } = await import("../../packages/cli/src/main.js");
    const fetchImplementation = vi.fn();
    let stderr = "";
    const code = await executeCli(["admin", "task", "e2e-replay", "start", "--task", "nope", "--round", ROUND], {
      fetchImplementation: fetchImplementation as unknown as typeof globalThis.fetch, stdout: { write: () => true }, stderr: { write: (text: string) => { stderr += text; return true; } } });
    expect(code).not.toBe(0);
    expect(stderr).toContain("--task and --round must be IDs");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
