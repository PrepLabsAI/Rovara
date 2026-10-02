// Spec 052 Task 5: `agentx admin eval batch start|show|stop|results`, against the admin routes.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  batchResultsOutput,
  evalBatchShowText,
  evalBatchStartText,
  readEvalBatchFile,
  showEvalBatch,
  startEvalBatch,
  stopEvalBatch,
  fetchEvalBatchResults,
} from "../../packages/cli/src/admin/eval-batch.js";
import { evalBatchPlaceholderThreadTs, isPlaceholderThreadTs } from "../../packages/broker/src/aws/eval-batch-admin.js";
import { exitCodeForError } from "../../packages/cli/src/output.js";

const base = { controlPlaneUrl: "https://api.example.com/", accessToken: "token" };
const batchId = "4f1d7c1e-0f5e-5b57-8c0b-0d3b1a1e9a11";
const yamlFile = `
benchmark: verified
tasks: [django__django-11099, django__django-11100]
models:
  - { provider: amazon-bedrock, modelId: us.vendor.batch-v1, thinkingLevel: low }
costCapUsd: 100
`;

function fakeFetch(status = 200, body: unknown = {}) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- typed so the calls' URL and init can be read
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

async function tempFile(name: string, content: string) {
  const path = join(await mkdtemp(join(tmpdir(), "agentx-batch-")), name);
  await writeFile(path, content);
  return path;
}

describe("agentx admin eval batch start (spec 052 FR-001, FR-003)", () => {
  it("parses and validates the YAML, then posts it with the team and channel", async () => {
    const filePath = await tempFile("batch.yaml", yamlFile);
    const answer = { created: true, batch: { batchId, status: "RUNNING" } };
    const fetchImplementation = fakeFetch(200, answer);
    const result = await startEvalBatch({ ...base, teamId: "T0BSHLLUGBD", channelId: "C0123456789", filePath }, fetchImplementation as typeof fetch);
    expect(result).toEqual(answer);
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/admin/evals/batches");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: "Bearer token" });
    expect(JSON.parse(init!.body as string)).toEqual({
      teamId: "T0BSHLLUGBD", channelId: "C0123456789",
      file: { benchmark: "verified", tasks: ["django__django-11099", "django__django-11100"], models: [{ provider: "amazon-bedrock", modelId: "us.vendor.batch-v1", thinkingLevel: "low" }], repeats: 1, order: "cheapest-first", costCapUsd: 100 },
    });
  });

  it("sends the same body for a repeated start, so the route finds the same batch", async () => {
    const filePath = await tempFile("batch.yaml", yamlFile);
    const fetchImplementation = fakeFetch(200, { created: true });
    const input = { ...base, teamId: "T0BSHLLUGBD", channelId: "C0123456789", filePath };
    await startEvalBatch(input, fetchImplementation as typeof fetch);
    await startEvalBatch(input, fetchImplementation as typeof fetch);
    expect(fetchImplementation.mock.calls[1]![1]!.body).toBe(fetchImplementation.mock.calls[0]![1]!.body);
  });

  it("prints the batch ID, and the thread only when the route returns one", () => {
    const text = evalBatchStartText({ created: true, batch: { batchId, status: "RUNNING", runs: 2 } });
    expect(text).toContain(batchId);
    expect(text).not.toMatch(/thread/i);
    expect(evalBatchStartText({ created: true, batch: { batchId }, thread: { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" } })).toContain("C0123456789/1695500000.000001");
    expect(evalBatchStartText({ created: false, batch: { batchId } })).toMatch(/already exists/);
  });

  it("prints a file's validation errors readably, and posts nothing", async () => {
    const filePath = await tempFile("bad.yaml", "benchmark: verified\nmodels: []\ncostCapUsd: 5000\n");
    const fetchImplementation = fakeFetch();
    const failure = await startEvalBatch({ ...base, teamId: "T0BSHLLUGBD", channelId: "C0123456789", filePath }, fetchImplementation as typeof fetch).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/is not a valid batch file/);
    expect((failure as Error).message).toMatch(/models: /);
    expect((failure as Error).message).toMatch(/costCapUsd: /);
    expect((failure as Error).message).not.toMatch(/ZodError|\[\s*\{/);
    expect(fetchImplementation).not.toHaveBeenCalled();
    await expect(readEvalBatchFile(await tempFile("broken.yaml", "models: [unclosed"))).rejects.toThrow(/not valid YAML/);
    await expect(readEvalBatchFile("/nonexistent/batch.yaml")).rejects.toThrow(/cannot read/);
  });

  it("prints the broker's refusal reason and fails with a non-zero exit code", async () => {
    const filePath = await tempFile("batch.yaml", yamlFile);
    const refusing = fakeFetch(400, { error: { code: "CONFIG_INVALID", message: "model amazon-bedrock/us.vendor.batch-v1 is not approved for this project" } });
    const failure = await startEvalBatch({ ...base, teamId: "T0BSHLLUGBD", channelId: "C0123456789", filePath }, refusing as typeof fetch).catch((error: Error & { code?: string }) => error);
    expect((failure as Error).message).toContain("is not approved for this project");
    expect(exitCodeForError((failure as { code: never }).code)).not.toBe(0);
  });
});

describe("agentx admin eval batch show and stop (spec 052 FR-009, Ruling 11)", () => {
  it("reads and stops a batch by ID", async () => {
    const fetchImplementation = fakeFetch(200, { ended: false, batch: { batchId } });
    await showEvalBatch({ ...base, batchId }, fetchImplementation as typeof fetch);
    await stopEvalBatch({ ...base, batchId }, fetchImplementation as typeof fetch);
    expect(fetchImplementation.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`https://api.example.com/v1/admin/evals/batches/${batchId}`, "GET"],
      [`https://api.example.com/v1/admin/evals/batches/${batchId}/stop`, "POST"],
    ]);
    await expect(showEvalBatch({ ...base, batchId: "nope" }, fetchImplementation as typeof fetch)).rejects.toThrow(/batch ID/);
  });

  it("reports progress, an ended batch's final status, and that a stop found it already ended", () => {
    const running = { ended: false, batch: { batchId, status: "RUNNING", spentUsd: 12.5, file: { costCapUsd: 100 }, counts: { queued: 3, starting: 0, running: 2, done: 4, failed: 1, cancelled: 0, notStarted: 0 }, runs: 10 } };
    const progress = evalBatchShowText(running);
    expect(progress).toContain("RUNNING");
    expect(progress).toContain("$12.50 of $100");
    expect(progress).toMatch(/done 4/);
    const ended = { ...running, ended: true, batch: { ...running.batch, status: "CAPPED" } };
    expect(evalBatchShowText(ended)).toMatch(/ended: CAPPED/);
    expect(evalBatchShowText({ ...ended, alreadyEnded: true })).toMatch(/already ended \(CAPPED\)/);
    expect(evalBatchShowText({ ...running, alreadyEnded: false, batch: { ...running.batch, status: "STOPPING" } })).toMatch(/stopping/i);
  });
});

describe("a CLI batch's placeholder thread (spec 052)", () => {
  it("is distinct from any real Slack timestamp, and stable per batch", () => {
    const placeholder = evalBatchPlaceholderThreadTs(batchId);
    expect(placeholder).toMatch(/^00\d{8}\.\d{6}$/);
    expect(isPlaceholderThreadTs(placeholder)).toBe(true);
    expect(isPlaceholderThreadTs("1695500000.000001")).toBe(false);
    expect(evalBatchPlaceholderThreadTs(batchId)).toBe(placeholder);
    expect(evalBatchPlaceholderThreadTs("00000000-0000-5000-8000-000000000000")).not.toBe(placeholder);
  });
});

describe("agentx admin eval batch results (spec 052 FR-010)", () => {
  const summary = { batchId, models: [{ provider: "amazon-bedrock", modelId: "us.vendor.batch-v1", thinkingLevel: "low", runs: 4, failed: 1, cancelled: 0, retried: 0, resolved: 3, rate: 0.75, wilsonLow: 0.3, wilsonHigh: 0.95, totalCostUsd: 12.5, unpricedRuns: 0, costPerSolvedUsd: 4.1667 }] };

  it("fetches through the broker and writes the CSV where --csv says", async () => {
    const fetchImplementation = fakeFetch(200, { ready: true, status: "DONE", csv: "batchId,runId\nx,y\n", summary });
    const results = await fetchEvalBatchResults({ ...base, batchId }, fetchImplementation as typeof fetch);
    expect(fetchImplementation.mock.calls[0]![0]).toBe(`https://api.example.com/v1/admin/evals/batches/${batchId}/results`);
    const csvPath = join(await mkdtemp(join(tmpdir(), "agentx-batch-")), "out.csv");
    const written = await batchResultsOutput(results, csvPath);
    expect(await readFile(csvPath, "utf8")).toBe("batchId,runId\nx,y\n");
    expect(written).toContain(csvPath);
  });

  it("prints the per-model summary table without --csv", async () => {
    const text = await batchResultsOutput({ ready: true, status: "DONE", csv: "", summary }, undefined);
    expect(text).toContain("amazon-bedrock/us.vendor.batch-v1");
    expect(text).toMatch(/3\/4/);
    expect(text).toContain("75.0%");
    expect(text).toContain("$12.50");
  });

  it("gives a clear message, not a crash, when the results are not written yet", async () => {
    const message = "batch x has ended (STOPPED), but its results are not written yet; try again shortly";
    const csvPath = join(await mkdtemp(join(tmpdir(), "agentx-batch-")), "never.csv");
    expect(await batchResultsOutput({ ready: false, status: "STOPPED", message }, undefined)).toBe(message);
    // With --csv a script waits for a file: no file is a failure.
    await expect(batchResultsOutput({ ready: false, status: "STOPPED", message }, csvPath)).rejects.toThrow("not written yet");
    await expect(readFile(csvPath, "utf8")).rejects.toThrow();
  });
});
