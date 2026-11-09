// Plan 3 Task 26, fix round 1 (review I3): when the control plane refuses a model key because no AI source serves the step's model (MODEL_NOT_ALLOWED), the
// words reach the people who can act on them. The worker ends the task with a refusal that keeps its text, not RUNTIME_UNAVAILABLE, whether the refusal comes
// with the first key or with a key asked for again an hour in; the Slack service shows the member the text, not "proxy unavailable".
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { safeRefusalWords } from "../../packages/contracts/src/index.js";
import { ModelNotAllowedError, createConfiguredModelRuntime, modelNotAllowedFromMarker } from "../../packages/model-runtime/src/index.js";
import { modelAccessSource } from "../../packages/worker/src/model-access.js";
import { failedTurn } from "../../packages/worker/src/session-events.js";

const PROXY_URL = "http://internal-proxy.example.test:4000";
const BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-6";
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const TEXT = "The AI source this step was running on is no longer available to your company. Ask an admin to check your AI sources, then continue the task.";
const refusal = (code: string, message: string, status = 403) => new Response(JSON.stringify({ error: { code, message } }), { status });
const caught = (response: Response) => modelAccessSource({ controlPlaneUrl: "https://api.example.test", capability: "cap.sig", fetch: async () => response.clone() })().catch((error: unknown) => error);

describe("the worker's model access meets MODEL_NOT_ALLOWED", () => {
  it("ends on it with the control plane's words", async () => {
    // By name: the worker's source imports the package's built copy of the class, this test its source's.
    expect(await caught(refusal("MODEL_NOT_ALLOWED", TEXT))).toMatchObject({ name: "ModelNotAllowedError", text: TEXT });
  });

  it("keeps the words bounded and free of control characters", async () => {
    const error = await caught(refusal("MODEL_NOT_ALLOWED", `Ask\u001b[31m an\u0000 admin ${"x".repeat(900)}`)) as ModelNotAllowedError;
    expect(error.name).toBe("ModelNotAllowedError");
    expect(error.text).not.toMatch(/\p{Cc}/u);
    expect(error.text.length).toBeLessThanOrEqual(300);
  });

  it("turns Slack mentions and links into plain text, as one shared helper does for the worker and the Slack service (re-check m1, m5)", async () => {
    const dirty = "Ask <@U123ABC> or <!channel> in <#C0123|ops>, see <https://evil.example/x|the docs>.";
    const clean = "Ask @U123ABC or !channel in #C0123|ops, see https://evil.example/x|the docs.";
    expect(safeRefusalWords(dirty)).toBe(clean);
    expect(safeRefusalWords(dirty)).not.toMatch(/[<>]/u);
    expect(safeRefusalWords("  \u001b[31m<<x>>  ")).toBe("[31mx");
    expect(safeRefusalWords(5)).toBeUndefined();
    expect(safeRefusalWords("<>")).toBeUndefined();
    expect(safeRefusalWords("y".repeat(900))).toHaveLength(300);
    expect(await caught(refusal("MODEL_NOT_ALLOWED", dirty))).toMatchObject({ name: "ModelNotAllowedError", text: clean });
  });

  it.each([
    ["a 403 of another code", refusal("FORBIDDEN", "x")],
    ["a 403 without a body", new Response("", { status: 403 })],
    ["a 403 whose message is not text", new Response(JSON.stringify({ error: { code: "MODEL_NOT_ALLOWED", message: 5 } }), { status: 403 })],
    ["a 503", refusal("MODEL_PROXY_UNAVAILABLE", "x", 503)],
  ])("keeps %s a RUNTIME_UNAVAILABLE", async (_name, response) => {
    expect(await caught(response)).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("the model runtime carries the refusal", () => {
  it("refuses a runtime whose first key is refused, as the refusal and not as a proxy fault", async () => {
    const error = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL }, { proxy: { baseUrl: PROXY_URL, apiKey: async () => { throw new ModelNotAllowedError(TEXT); } } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelNotAllowedError);
  });

  it("carries a re-minted key's refusal to the worker in the stream's message, which the worker ends the task on", async () => {
    let asked = 0;
    const apiKey = async () => { asked += 1; if (asked > 1) throw new ModelNotAllowedError(TEXT); return "sk-proxy-key-0001"; };
    const runtime = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL }, { fetch: vi.fn<typeof fetch>(), proxy: { baseUrl: PROXY_URL, apiKey } });
    const model = runtime.getModel("amazon-bedrock", BEDROCK_MODEL)!;
    const result = await runtime.streamSimple(model, context, { maxTokens: 64 }).result();
    expect(result).toMatchObject({ stopReason: "error", errorMessage: `Model not allowed: ${TEXT}` });
    expect(modelNotAllowedFromMarker(result.errorMessage)).toMatchObject({ name: "ModelNotAllowedError", text: TEXT });
    const failure = failedTurn({ stopReason: "error", errorMessage: result.errorMessage! });
    expect(failure).toMatchObject({ code: "MODEL_NOT_ALLOWED", message: `MODEL_NOT_ALLOWED: ${TEXT}` });
  });

  it("does not take an ordinary model failure for a refusal", () => {
    expect(modelNotAllowedFromMarker("Anthropic request failed; check the API key")).toBeUndefined();
    expect(failedTurn({ stopReason: "error", errorMessage: "Anthropic request failed" })).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});
