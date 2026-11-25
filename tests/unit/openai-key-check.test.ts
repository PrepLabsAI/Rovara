// Rovara-cloud#308: a company's OpenAI key is tested with one free call to OpenAI before it is sealed, on connect and on rotate, so a
// wrong key is refused on the settings page rather than at the company's first agent call. Nothing is saved unless the test says ok,
// and the key never appears in an answer, an error or a stored row other than its sealed copy.
import { denyNetwork } from "./model-gateway-no-network.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { OPENAI_KEY_CHECK_URL, openAiKeyCheck, type OpenAiKeyCheck } from "../../packages/model-gateway/src/openai-key-check.js";
import { LEARNING_OWNER, ProductKeyError } from "../../packages/model-gateway/src/product-keys.js";
import { change, geminiKey, storeKit } from "./model-gateway-product-fixture.js";
beforeAll(denyNetwork);

const KEY = `sk-proj-${"A1b2".repeat(12)}`;
const answering = (status: number) => vi.fn(async () => new Response("{}", { status })) as unknown as typeof fetch;
const failure = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ProductKeyError ? e.code : `other:${String(e)}`));
const connectOpenAi = (kit: ReturnType<typeof storeKit>, key = KEY) => kit.store.connect({ ...change(LEARNING_OWNER, 0), sourceId: "src_openai", provider: "openai", key });

describe("the OpenAI key test", () => {
  it("is one GET to OpenAI's model list with the key as a bearer token, following no redirect", async () => {
    const send = answering(200);
    expect(await openAiKeyCheck({ fetch: send })(KEY)).toBe("ok");
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = (send as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe(OPENAI_KEY_CHECK_URL);
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(init).toMatchObject({ method: "GET", redirect: "error", headers: { authorization: `Bearer ${KEY}` } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("answers ok for an active key (also one restricted from listing models), refused for a key OpenAI does not know, else unavailable", async () => {
    const cases: Array<[number, string]> = [[200, "ok"], [403, "ok"], [401, "refused"], [429, "unavailable"], [500, "unavailable"], [503, "unavailable"], [302, "unavailable"], [404, "unavailable"]];
    for (const [status, expected] of cases) expect(await openAiKeyCheck({ fetch: answering(status) })(KEY), String(status)).toBe(expected);
    const broken = vi.fn(async () => { throw new Error(`network down for ${KEY}`); }) as unknown as typeof fetch;
    expect(await openAiKeyCheck({ fetch: broken })(KEY)).toBe("unavailable");
  });
});

describe("the key store runs it before sealing an OpenAI key", () => {
  const check = (result: Awaited<ReturnType<OpenAiKeyCheck>> | "throws") => vi.fn<OpenAiKeyCheck>(async () => { if (result === "throws") throw new Error(KEY); return result; });

  it("saves the key when the test says ok, and tests exactly the key that is sealed", async () => {
    const openaiCheck = check("ok");
    const kit = storeKit({ openaiCheck });
    expect(await failure(connectOpenAi(kit))).toBe("ok");
    expect(openaiCheck).toHaveBeenCalledWith(KEY);
    expect(await kit.store.learningSource(change(LEARNING_OWNER, 0).iss, change(LEARNING_OWNER, 0).cid, "openai")).toBeDefined();
  });

  it("refuses a key the test refuses, and saves nothing; a failed or unavailable test saves nothing either", async () => {
    for (const [result, code] of [["refused", "refused"], ["unavailable", "unavailable"], ["throws", "unavailable"]] as const) {
      const kit = storeKit({ openaiCheck: check(result) });
      const error = await connectOpenAi(kit).then(() => undefined, (e: unknown) => e);
      expect(error, result).toBeInstanceOf(ProductKeyError);
      expect((error as ProductKeyError).code, result).toBe(code);
      expect(String((error as Error).message)).not.toContain(KEY);
      expect([...kit.table.rows.keys()].filter((k) => k.includes("#key#")), result).toEqual([]);
      expect(JSON.stringify([...kit.table.rows.entries()])).not.toContain(KEY);
    }
  });

  it("tests a replacement key on rotate, and keeps the old key when the new one is refused", async () => {
    const results: Array<"ok" | "refused"> = ["ok", "refused", "ok"];
    const openaiCheck = vi.fn<OpenAiKeyCheck>(async () => results.shift()!);
    const kit = storeKit({ openaiCheck });
    const first = await connectOpenAi(kit);
    const replacement = `sk-proj-${"Z9y8".repeat(12)}`;
    const refused = await failure(kit.store.rotate({ ...change(LEARNING_OWNER, first.revision), sourceId: "src_openai", key: replacement }));
    expect(refused).toBe("refused");
    expect(openaiCheck).toHaveBeenLastCalledWith(replacement);
    const resolved = await kit.store.learningSource(change(LEARNING_OWNER, 0).iss, change(LEARNING_OWNER, 0).cid, "openai");
    expect(resolved).toBeDefined();
    expect(await kit.store.useKey(change(LEARNING_OWNER, 0).iss, change(LEARNING_OWNER, 0).cid, resolved!)).toBe(KEY);
    expect(await failure(kit.store.rotate({ ...change(LEARNING_OWNER, first.revision), sourceId: "src_openai", key: replacement }))).toBe("ok");
    expect(openaiCheck).toHaveBeenCalledTimes(3);
  });

  it("does not test any other provider's key, and an OpenAI key is saved untested where no test is configured (as before)", async () => {
    const openaiCheck = check("refused");
    const kit = storeKit({ openaiCheck });
    expect(await failure(kit.store.connect({ ...change(LEARNING_OWNER, 0), sourceId: "src_gemini", provider: "gemini", key: geminiKey() }))).toBe("ok");
    expect(openaiCheck).not.toHaveBeenCalled();
    expect(await failure(connectOpenAi(storeKit()))).toBe("ok");
  });
});
