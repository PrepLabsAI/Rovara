// TE-F2 part B: the helper PROGRAM. It serves only the bundle that hashes to its `--digest`, refuses anything else before it listens, and `--summarize` prints one line of JSON (run here as the real built program).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ModelHelperRefused, serveModelHelper } from "../../packages/worker/src/model-helper.js";
import { modelHelperArgs, parseModelHelperArgs } from "../../packages/worker/src/model-helper-args.js";
import { parseModelHelperSummary } from "../../packages/worker/src/model-helper-ledger.js";
import { writeModelHelperRunFiles } from "../../packages/worker/src/model-helper-round.js";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { ModelReplySetSchema, parseModelReplySetFileBytes } from "../../packages/contracts/src/index.js";
import { OPENAI_BODY, ROWS, request, stampSet, startWorld } from "../support/model-helper-world.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "../../packages/worker/dist/model-helper.js");

async function setup(digestOverride?: string) {
  const parent = mkdtempSync(join(tmpdir(), "rsmp-"));
  dirs.push(parent);
  const files = await writeModelHelperRunFiles({ parent, rows: ROWS, sets: [stampSet("openai_compatible", [{ id: "chat", response: { text: "From the program.", finish: "stop" } }])] });
  const ledger = join(parent, "ledger.jsonl");
  const args = parseModelHelperArgs(modelHelperArgs({
    listen: "127.0.0.1", port: 0, metaPort: 0, caller: "127.0.0.1", mode: "scripted", rows: files.rowsPath, replies: files.repliesPath, digest: digestOverride ?? files.digest, ledger, blockState: "by_name", projectId: undefined, recordEscapes: false,
  }));
  return { files, ledger, args, parent };
}

describe("the helper program", () => {
  it("serves the pinned bundle and writes its ledger", async () => {
    const { args, ledger } = await setup();
    const loop = await serveModelHelper(args);
    try {
      const reply = await request(`http://127.0.0.1:${String(loop.port)}/p/openai/v1/chat/completions`, { method: "POST", body: OPENAI_BODY });
      expect(reply.body).toContain("From the program.");
    } finally {
      await loop.close();
    }
    const out = execFileSync(process.execPath, [ENTRY, "--summarize", "--ledger", ledger], { env: {}, encoding: "utf8" });
    expect(parseModelHelperSummary(out)).toMatchObject({ trusted: true, blockState: "by_name", scripted: { before_task: 1 }, countsTowardProof: 1 });
  });
  it("refuses a bundle that is not the pinned one, a missing file and a tampered file, and nothing listens", async () => {
    const wrong = await setup("f".repeat(64));
    await expect(serveModelHelper(wrong.args)).rejects.toMatchObject({ reason: "replies" });
    const ok = await setup();
    writeFileSync(ok.files.repliesPath, Buffer.from(JSON.stringify({ version: 1, sets: [] })));
    await expect(serveModelHelper(ok.args)).rejects.toBeInstanceOf(ModelHelperRefused);
    await expect(serveModelHelper({ ...ok.args, rows: join(ok.parent, "missing.json") })).rejects.toMatchObject({ reason: "rows" });
  });
  it("--summarize on a missing or damaged ledger is an untrusted summary, never 'no calls'", async () => {
    const { parent } = await setup();
    const missing = parseModelHelperSummary(execFileSync(process.execPath, [ENTRY, "--summarize", "--ledger", join(parent, "none.jsonl")], { env: {}, encoding: "utf8" }));
    expect(missing).toMatchObject({ trusted: false, scripted: { before_task: 0 } });
    const damaged = join(parent, "damaged.jsonl");
    writeFileSync(damaged, '{"header":1,"mode":"scripted","blockState":"by_name","digest":"' + "a".repeat(64) + '","startedAt":1}\n{"t":1,"kind":"scripted","status":200,"extra":1}\n');
    expect(parseModelHelperSummary(execFileSync(process.execPath, [ENTRY, "--summarize", "--ledger", damaged], { env: {}, encoding: "utf8" }))).toMatchObject({ trusted: false });
    // two headers and an overflow marker are untrusted too
    const two = join(parent, "two.jsonl");
    const header = '{"header":1,"mode":"scripted","blockState":"by_name","digest":"' + "a".repeat(64) + '","startedAt":1}';
    writeFileSync(two, `${header}\n${header}\n`);
    expect(parseModelHelperSummary(execFileSync(process.execPath, [ENTRY, "--summarize", "--ledger", two], { env: {}, encoding: "utf8" }))?.trusted).toBe(false);
    const over = join(parent, "over.jsonl");
    writeFileSync(over, `${header}\n{"overflow":true}\n`);
    expect(parseModelHelperSummary(execFileSync(process.execPath, [ENTRY, "--summarize", "--ledger", over], { env: {}, encoding: "utf8" }))?.trusted).toBe(false);
  });
});

describe("the scripted-run fixture handed to F1-g (tests/fixtures/model-helper/scripted-run)", () => {
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/model-helper/scripted-run");
  it("its reply file is a valid reply-set file, and its honouring client gets the scripted answer from the helper", async () => {
    const parsed = parseModelReplySetFileBytes(readFileSync(join(FIXTURE, ".rovara/mocks/model/openai_compatible.json")));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const set = ModelReplySetSchema.parse({ ...parsed.set, replies: parsed.set.replies.map((reply) => ({ ...reply, provenance: "before_task", origin: "customer_written" })) });
    const world = await startWorld({ sets: [set] });
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [join(FIXTURE, "honours-redirect.mjs")], { env: { OPENAI_BASE_URL: `${world.base}/p/openai/v1`, OPENAI_API_KEY: "rovara-test-key" } });
      expect(stdout.trim()).toBe("Hello from the scripted reply.");
      expect(world.summary()).toMatchObject({ scripted: { before_task: 1 }, countsTowardProof: 1 });
    } finally {
      await world.close();
    }
  });
});
