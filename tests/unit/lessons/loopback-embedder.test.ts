// The small open embedding model served on this machine (decision 23): only a loopback address is accepted, every answer is checked before a vector is used, every failure is one fixed code that says
// nothing of the text, and the environment either chooses a real embedder or is refused (a typo never quietly means "no embedder").
import { describe, expect, it } from "vitest";
import { runLessonEmbedderConformance } from "../../support/ports/learning-conformance.js";
import {
  HASHING_EMBEDDER_SPEC, createHashingEmbedder, LOOPBACK_EMBEDDER_LIMITS, LoopbackEmbedderError, createLoopbackEmbedder, learningAdapterFromEnvironment, loopbackBase,
} from "../../../packages/broker/src/lessons/local-embedder.js";

type Call = { url: string; body: { model: string; input: string[] } };

/** A fake embedding server: each text's vector is its length in the first slot and 1 in the second, scaled by `scale` (so the client's own scaling to length 1 is visible). */
function server(over: { status?: number; reply?: (input: string[]) => unknown; scale?: number; throws?: boolean } = {}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Call["body"];
    calls.push({ url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url, body });
    if (over.throws === true) throw new TypeError("fetch failed: connection refused for the text 'secret lesson words'");
    const reply = over.reply?.(body.input) ?? { data: body.input.map((text, index) => ({ index, embedding: [text.length * (over.scale ?? 1), 1 * (over.scale ?? 1), 0, 0, 0, 0, 0, 0] })) };
    return new Response(JSON.stringify(reply), { status: over.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fake, calls };
}

const make = (fake: typeof fetch, over: Partial<Parameters<typeof createLoopbackEmbedder>[0]> = {}) => createLoopbackEmbedder({ url: "http://127.0.0.1:11434/v1", model: "bge-small-en-v1.5", dimension: 8, fetch: fake, ...over });

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try { await promise; return undefined; } catch (error) { return error instanceof LoopbackEmbedderError ? error.code : `not fixed: ${String(error)}`; }
};

describe("the address", () => {
  it("is accepted only on this machine: loopback hosts over http or https, with no user, password or query", () => {
    expect(loopbackBase("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434/v1");
    expect(loopbackBase("http://localhost:8080")).toBe("http://localhost:8080");
    expect(loopbackBase("http://[::1]:9000/api")).toBe("http://[::1]:9000/api");
    for (const refused of ["https://api.example.com/v1", "http://10.0.0.5:11434", "http://127.0.0.1.nip.io/v1", "http://user:pw@127.0.0.1:1/v1", "http://127.0.0.1:1/v1?key=x", "file:///tmp/x", "ftp://127.0.0.1/", "not a url"]) {
      expect(loopbackBase(refused), refused).toBeUndefined();
    }
    expect(() => make(server().fetch, { url: "https://api.example.com/v1" })).toThrow(LoopbackEmbedderError);
  });

  it("refuses a model name or a vector size that is not plausible", () => {
    expect(() => make(server().fetch, { model: "bad name; rm -rf" })).toThrow("BAD_CONFIG");
    expect(() => make(server().fetch, { dimension: 4 })).toThrow("BAD_CONFIG");
    expect(() => make(server().fetch, { dimension: 1.5 })).toThrow("BAD_CONFIG");
  });
});

describe("a call", () => {
  it("posts the texts to <base>/embeddings with the model, and returns unit vectors in the order asked; the spec names the model and size", async () => {
    const s = server({ scale: 7 });
    const embedder = make(s.fetch);
    expect(embedder.spec).toBe("loopback:bge-small-en-v1.5:8");
    expect(embedder.dimension).toBe(8);
    const [a, b] = await embedder.embedMany(["  abc ", "abcdef"]);
    expect(s.calls[0]).toMatchObject({ url: "http://127.0.0.1:11434/v1/embeddings", body: { model: "bge-small-en-v1.5", input: ["abc", "abcdef"] } });
    for (const vector of [a!, b!]) expect(Math.hypot(...vector)).toBeCloseTo(1, 10);
    expect(a![0]! / a![1]!).toBeCloseTo(3, 10);
    expect(b![0]! / b![1]!).toBeCloseTo(6, 10);
    expect(await embedder.embed("x")).toHaveLength(8);
  });

  it("keeps the order the server says by index, splits a long list into requests of at most 16 texts, and cuts a long text", async () => {
    const reversed = server({ reply: (input) => ({ data: input.map((text, index) => ({ index, embedding: [text.length, 1, 0, 0, 0, 0, 0, 0] })).reverse() }) });
    const [first] = await make(reversed.fetch).embedMany(["a", "abcd"]);
    expect(first![0]! / first![1]!).toBeCloseTo(1, 10);
    const s = server();
    await make(s.fetch).embedMany(Array.from({ length: 40 }, (_, i) => `text ${String(i)}`));
    expect(s.calls.map((call) => call.body.input.length)).toEqual([16, 16, 8]);
    await make(s.fetch).embedMany(["y".repeat(LOOPBACK_EMBEDDER_LIMITS.maxTextChars + 50)]);
    expect(s.calls.at(-1)!.body.input[0]).toHaveLength(LOOPBACK_EMBEDDER_LIMITS.maxTextChars);
  });

  it("refuses every answer it cannot trust, with a fixed code and nothing of the text or the server's words", async () => {
    const cases: Array<[Parameters<typeof server>[0], string]> = [
      [{ status: 500 }, "UNREACHABLE"],
      [{ throws: true }, "UNREACHABLE"],
      [{ reply: () => ({ nothing: true }) }, "BAD_RESPONSE"],
      [{ reply: (input) => ({ data: input.slice(1).map((_, index) => ({ index, embedding: [1, 1, 0, 0, 0, 0, 0, 0] })) }) }, "BAD_RESPONSE"],
      [{ reply: (input) => ({ data: input.map((_, index) => ({ index, embedding: [1, 1, 0] })) }) }, "BAD_RESPONSE"],
      [{ reply: (input) => ({ data: input.map((_, index) => ({ index, embedding: [1, Number.NaN, 0, 0, 0, 0, 0, 0] })) }) }, "BAD_RESPONSE"],
      [{ reply: (input) => ({ data: input.map((_, index) => ({ index, embedding: [0, 0, 0, 0, 0, 0, 0, 0] })) }) }, "BAD_RESPONSE"],
      [{ reply: (input) => ({ data: input.map(() => ({ index: 0, embedding: [1, 1, 0, 0, 0, 0, 0, 0] })) }) }, "BAD_RESPONSE"],
      [{ reply: (input) => ({ data: input.map(() => ({ index: 9, embedding: [1, 1, 0, 0, 0, 0, 0, 0] })) }) }, "BAD_RESPONSE"],
    ];
    for (const [over, code] of cases) {
      const failure = await make(server(over).fetch).embedMany(["secret lesson words", "more"]).then(() => undefined, (error: unknown) => error);
      expect(failure, JSON.stringify(over)).toBeInstanceOf(LoopbackEmbedderError);
      expect((failure as LoopbackEmbedderError).code).toBe(code);
      expect((failure as Error).message).not.toContain("secret");
    }
    // A blank text is the zero vector, and the server is not asked about it.
    const s = server();
    const [fine, blank] = await make(s.fetch).embedMany(["fine", "   "]);
    expect(Math.hypot(...fine!)).toBeCloseTo(1, 10);
    expect(blank!.every((value) => value === 0)).toBe(true);
    expect(s.calls.map((call) => call.body.input)).toEqual([["fine"]]);
  });

  it("never waits past the caller's deadline: a deadline already gone sends nothing", async () => {
    const s = server();
    const embedder = make(s.fetch, { now: () => 1_000 });
    expect(await codeOf(embedder.embedMany(["a"], "query", { deadline: 1_000 }))).toBe("UNREACHABLE");
    expect(s.calls).toHaveLength(0);
    await embedder.embedMany(["a"], "query", { deadline: 5_000 });
    expect(s.calls).toHaveLength(1);
  });
});

describe("the environment", () => {
  it("chooses keywords alone, the in-process hashing embedder, or the model on this machine; anything else is refused", async () => {
    expect("embedder" in learningAdapterFromEnvironment({})).toBe(false);
    expect(learningAdapterFromEnvironment({ ROVARA_LESSONS_EMBEDDER: "" }).kind).toBe("local");
    expect(learningAdapterFromEnvironment({ ROVARA_LESSONS_EMBEDDER: "local" }).embedder?.("c")?.spec).toBe(HASHING_EMBEDDER_SPEC);
    const s = server({ reply: (input) => ({ data: input.map((_, index) => ({ index, embedding: Array.from({ length: 384 }, (__, i) => (i === 0 ? 1 : 0)) })) }) });
    const adapter = learningAdapterFromEnvironment({ ROVARA_LESSONS_EMBEDDER: "http://127.0.0.1:11434/v1", ROVARA_LESSONS_EMBEDDER_MODEL: "bge-small-en-v1.5" }, { fetch: s.fetch });
    expect(adapter.kind).toBe("local-model");
    const embedder = adapter.embedder?.("c");
    expect(embedder?.spec).toBe("loopback:bge-small-en-v1.5:384");
    expect(await embedder?.embed("hello")).toHaveLength(384);
    expect(() => learningAdapterFromEnvironment({ ROVARA_LESSONS_EMBEDDER: "https://api.example.com/v1", ROVARA_LESSONS_EMBEDDER_MODEL: "m" })).toThrow(/on this machine/);
    expect(() => learningAdapterFromEnvironment({ ROVARA_LESSONS_EMBEDDER: "http://127.0.0.1:1/v1" })).toThrow(/ROVARA_LESSONS_EMBEDDER_MODEL/);
    expect(() => learningAdapterFromEnvironment({ ROVARA_LESSONS_EMBEDDER: "http://127.0.0.1:1/v1", ROVARA_LESSONS_EMBEDDER_MODEL: "m", ROVARA_LESSONS_EMBEDDER_DIMENSION: "lots" })).toThrow(/not valid/);
    expect(() => learningAdapterFromEnvironment({ ROVARA_LESSONS_EMBEDDER: "yes" })).toThrow(/on this machine/);
  });
});

// The port's own conformance suite, against the loopback embedder over a fake server that answers with the hashing embedder's vectors (deterministic, and like texts are near).
runLessonEmbedderConformance("Code's loopback model embedder", {
  async create() {
    const backend = createHashingEmbedder();
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      const input = (JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { input: string[] }).input;
      return new Response(JSON.stringify({ data: (await backend.embedMany(input)).map((embedding, index) => ({ index, embedding })) }), { status: 200 });
    }) as typeof fetch;
    return { embedder: createLoopbackEmbedder({ url: "http://127.0.0.1:11434/v1", model: "bge-small-en-v1.5", dimension: backend.dimension, fetch: fake }) };
  },
});
