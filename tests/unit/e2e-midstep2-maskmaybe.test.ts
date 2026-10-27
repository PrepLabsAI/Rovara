import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyString, credentialKey, isDigitlessRandomToken, type ClassifiedValue } from "../../packages/verifier/src/executor/credential-classifier.js";
import { classifyStorageEntry } from "../../packages/verifier/src/executor/storage-entry-classifier.js";
import { headerSecrets, urlSecrets } from "../../packages/verifier/src/executor/request-secrets.js";
import { createE2EModelChannelClient } from "../../packages/verifier/src/executor/model-channel.js";
import { createHostModelStack } from "../../packages/verifier/src/executor/host-model-stack.js";
import { maskModelCall, ModelMaskDepthError } from "../../packages/verifier/src/executor/model-mask.js";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { RUN_ID, TOOLS, call } from "../support/e2e-model-fixtures.js";
import { MIDSTEP2_POSITION as POSITION, createMidstep2Harness } from "../support/e2e-midstep2-harness.js";

// MIDSTEP-2 MASKMAYBE: a weak (evidence-only) value is replaced by `<session>` in everything sent to the model, the step goes on, a strong value still refuses; and the key reading / classifier changes
// of the fourth re-check (R4-1, R4-2, R4-3). The real worker proxy, redactor, registry, session source, channel client and model adapter; only the browser state is a stand-in (the OTP test has a real Chromium).

const WEAK = "Dk3pQ9xW2mV7cL4nR8tY";
const ROUTE = "/projects/alpha/settings/notifications2";
const STRONG = "Qe5rT8yU1iO4pA7sD0fG3hJ6kL9zXcVb";
const OPAQUE = "Zk3pQ9xW2mV7cL4nR8tY1bH6jD5sA0gF";
const tierOf = (items: readonly ClassifiedValue[], value: string) => items.find((item) => item.value === value)?.tier ?? null;

let dir: string;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(async () => { cleanRedirectingEnvironment(); dir = await mkdtemp(join(tmpdir(), "mm-")); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });
const harness = createMidstep2Harness({ dir: () => dir, closers });

type Part = { type: "text"; text: string };
const TOOLS_V4 = TOOLS.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
const user = (text: string): { role: "user"; content: Part[] } => ({ role: "user", content: [{ type: "text", text }] });

describe("change 1: a weak value is masked in every model-bound text, the step continues, a strong value still refuses", () => {
  async function stackFor(storage: Array<{ name: string; value: string }>) {
    const e = await harness.executor();
    e.state.current = { cookies: [], origins: [{ localStorage: storage }] };
    const stack = createHostModelStack({ socketPath: e.run.socketPath, runId: RUN_ID, routeId: "rovara-e2e-default", registry: e.registry, sessionSync: e.source, position: () => POSITION });
    return { e, stack };
  }

  it("every kind of text in a call (system, page snapshot, URL, tool call, tool result, tool description) is masked; the weak value was learned by the sync inside the call; the call is answered", async () => {
    const { e, stack } = await stackFor([{ name: "lastDocument", value: WEAK }, { name: "lastVisited", value: ROUTE }]);
    expect(e.registry.sessionSecrets).toEqual([]);
    const answer = await stack.adapter.doGenerate({
      prompt: [
        { role: "system", content: `You drive an app. The last document was ${WEAK}.` },
        user(`#n1 text "Document ${WEAK}"\n#n2 link "Back" href="${ROUTE}"\nurl: http://app.test/open?next=${encodeURIComponent(ROUTE)}&doc=${WEAK}`),
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "type", input: { target: "n2", value: WEAK } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "type", output: { type: "text", value: `Typed ${WEAK} at ${ROUTE}` } }],
        },
      ],
      tools: [{ type: "function", name: "tap", description: `Tap one node, for example the one that opens ${WEAK}`, inputSchema: TOOLS[0]!.inputSchema }],
    }) as { content: unknown[] };
    // The step went on: the model answered.
    expect(answer.content).toHaveLength(1);
    expect(e.run.seen).toHaveLength(1);
    const call = e.run.seen[0] as { prompt: Array<{ role: string; content: unknown }>; tools: Array<{ description: string }> };
    const wire = JSON.stringify(call);
    for (const spelling of [WEAK, ROUTE, encodeURIComponent(ROUTE)]) expect(wire, spelling).not.toContain(spelling);
    expect(call.prompt[0]!.content).toBe("You drive an app. The last document was <session>.");
    expect((call.prompt[1]!.content as Part[])[0]!.text).toBe('#n1 text "Document <session>"\n#n2 link "Back" href="<session>"\nurl: http://app.test/open?next=<session>&doc=<session>');
    expect(JSON.stringify(call.prompt[2]!.content)).toContain('"value":"<session>"');
    expect(JSON.stringify(call.prompt[3]!.content)).toContain("Typed <session> at <session>");
    expect(call.tools[0]!.description).toBe("Tap one node, for example the one that opens <session>");
    // The weak value is the executor's alone: it was not told to the worker, and the registry still scrubs it from evidence.
    expect(e.registry.sessionSecrets).toEqual([]);
    expect(e.redactor.contains(Buffer.from(WEAK), "all")).toBe(true);
    expect(e.redactor.contains(Buffer.from(WEAK), "model")).toBe(false);
  });

  it("positive control: the same text through a client WITHOUT the mask reaches the model unmasked, so the mask is what hid it", async () => {
    const { e } = await stackFor([{ name: "lastDocument", value: WEAK }]);
    expect((await e.workerSays(`Document ${WEAK}`)).status).toBe("ok");
    expect(JSON.stringify(e.run.seen[0])).toContain(WEAK);
  });

  it("a call that shows nothing registered is forwarded exactly as built (ordinary text, a 6-digit code, words)", async () => {
    const { e, stack } = await stackFor([{ name: "lastDocument", value: WEAK }]);
    const text = '#n1 textbox "Code"\n#n2 text "Your code is 482915 and the report is Quarterly report for ACME, order 1234"';
    await stack.adapter.doGenerate({ prompt: [user(text)], tools: TOOLS_V4 });
    expect((e.run.seen[0] as { prompt: Array<{ content: Part[] }> }).prompt[0]!.content[0]!.text).toBe(text);
  });

  it("a strong value still refuses the call, with the weak value beside it (the step is not continued, nothing reaches the model)", async () => {
    const { e, stack } = await stackFor([{ name: "lastDocument", value: WEAK }, { name: "access_token", value: STRONG }]);
    await expect(stack.adapter.doGenerate({ prompt: [user(`Document ${WEAK}, key ${STRONG}`)], tools: TOOLS_V4 })).rejects.toMatchObject({ code: "credential-in-prompt" });
    await expect(stack.client.generate({ ...POSITION, callIndex: 5, call: { prompt: [{ role: "user", content: [{ type: "text", text: `Document ${WEAK}, key ${STRONG}` }] }] } as never })).rejects.toMatchObject({ code: "credential-in-prompt" });
    expect(e.run.seen).toHaveLength(0);
    expect(e.registry.sessionSecrets).toContain(STRONG);
  });

  it("the credential scan runs on the call BEFORE the mask: a weak value that is a piece of a strong one cannot hide the strong one", async () => {
    const e = await harness.executor();
    e.registry.register(STRONG);
    e.registry.register(STRONG.slice(0, 20), { evidenceOnly: true });
    const stack = createHostModelStack({ socketPath: e.run.socketPath, runId: RUN_ID, routeId: "r", registry: e.registry, sessionSync: e.source, position: () => POSITION });
    // The channel client alone (the adapter's own scan would also refuse it before the client sees it).
    await expect(stack.client.generate({ ...POSITION, callIndex: 0, call: { prompt: [{ role: "user", content: [{ type: "text", text: `Key ${STRONG}` }] }] } as never })).rejects.toMatchObject({ code: "credential-in-prompt" });
    expect(e.run.seen).toHaveLength(0);
  });

  it("R4-2 end to end: a date, URL or host under a secret-sounding name is masked for the model and the call is NOT refused (it was strong, and refused, before)", async () => {
    const { e, stack } = await stackFor([{ name: "tokenEndpoint", value: "https://login.example.com/oauth2/token" }, { name: "sessionLastActive", value: "2026-10-27T09:15:00.000Z" }, { name: "authHost", value: "login.example.com" }]);
    await stack.adapter.doGenerate({ prompt: [user("Endpoint https://login.example.com/oauth2/token host login.example.com last active 2026-10-27T09:15:00.000Z")], tools: TOOLS_V4 });
    expect((e.run.seen[0] as { prompt: Array<{ content: Part[] }> }).prompt[0]!.content[0]!.text).toBe("Endpoint <session> host <session> last active <session>");
    expect(e.registry.sessionSecrets).toEqual([]);
  });

  it("a value registered weak and later as a credential is refused, not masked (the stronger tier wins)", async () => {
    const { e, stack } = await stackFor([{ name: "lastDocument", value: WEAK }]);
    await stack.adapter.doGenerate({ prompt: [user(`Document ${WEAK}`)], tools: TOOLS_V4 });
    e.registry.register(WEAK);
    await expect(stack.adapter.doGenerate({ prompt: [user(`Document ${WEAK}`)], tools: TOOLS_V4 })).rejects.toMatchObject({ code: "credential-in-prompt" });
  });
});

describe("the mask itself", () => {
  it("maskModelCall rewrites every string, keys included, in nested arrays and objects, and nothing else; a call nested deeper than 64 levels is refused", () => {
    const call = { a: "x SECRET y", n: 3, ok: true, none: null, list: ["SECRET", { SECRET: ["deep SECRET"] }] };
    const out = maskModelCall(call, (text) => text.split("SECRET").join("<session>"));
    expect(out).toEqual({ a: "x <session> y", n: 3, ok: true, none: null, list: ["<session>", { "<session>": ["deep <session>"] }] });
    expect(call.a).toBe("x SECRET y");
    let deep: unknown = "SECRET";
    for (let level = 0; level < 70; level += 1) deep = [deep];
    expect(() => maskModelCall(deep, (text) => text)).toThrow(ModelMaskDepthError);
  });

  it("the redactor masks only evidence-only values: an account password and a credential are left for the scan to refuse", () => {
    const redactor = createCredentialRedactor([{ profileId: "maya", email: "maya@example.com", password: "hunter2222-long" }]);
    redactor.addSessionSecret(STRONG);
    redactor.addSessionSecret(WEAK, { evidenceOnly: true });
    expect(redactor.maskEvidenceOnly(`a ${WEAK} b ${STRONG} c hunter2222-long`)).toBe(`a <session> b ${STRONG} c hunter2222-long`);
    // The percent-encoded and base64 spellings of the weak value are masked too.
    redactor.addSessionSecret(ROUTE, { evidenceOnly: true });
    expect(redactor.maskEvidenceOnly(`${encodeURIComponent(ROUTE)} ${Buffer.from(ROUTE).toString("base64url")}`)).toBe("<session> <session>");
  });
});

describe("the channel client's order of work around the mask", () => {
  it("the credential scan runs again on the MASKED call (a mask that produced a credential is refused, nothing is sent), and a mask that breaks the call's shape is refused as an invalid request", async () => {
    const e = await harness.executor();
    e.registry.register(STRONG);
    const withMask = (mask: (text: string) => string) => createE2EModelChannelClient({ socketPath: e.run.socketPath, runId: RUN_ID, sessionSync: e.source, scan: e.registry.modelScan, mask });
    await expect(withMask((text) => text.replace("PLACEHOLDER", STRONG)).generate({ ...POSITION, callIndex: 0, call: call("#n1 text PLACEHOLDER") })).rejects.toMatchObject({ code: "credential-in-prompt" });
    await expect(withMask((text) => (text === "user" ? "usr" : text)).generate({ ...POSITION, callIndex: 1, call: call("#n1 text hello") })).rejects.toMatchObject({ code: "invalid-request" });
    expect(e.run.seen).toHaveLength(0);
    // And an honest mask is sent: the same client shape with a mask that changes nothing reaches the model.
    expect((await withMask((text) => text).generate({ ...POSITION, callIndex: 0, call: call("#n1 text hello") })).result.status).toBe("ok");
    expect(e.run.seen).toHaveLength(1);
  });
});

describe("R4-1: a clear secret word wins over a route word", () => {
  const SECRET_ROUTE_KEYS = ["callbackToken", "nextToken", "returnToken", "authRedirectToken", "nextAuthToken", "next-auth.session-token", "__Secure-next-auth.session-token", "oauthCallbackToken", "originToken", "redirectSecret", "returnPassword"];
  it.each(SECRET_ROUTE_KEYS)("%s is a credential key", (name) => {
    expect(credentialKey(name)).toMatchObject({ credential: true, strongest: true });
  });
  it("a route key without a secret word stays out, and so do secret-sounding route names (a token's callback URL is not the token)", () => {
    for (const name of ["redirectAfterAuth", "returnTo", "next", "callbackUrl", "origin", "referrer", "nextPage", "authRedirect", "tokenCallback", "tokenOrigin", "tokenReferrer", "tokenReferer", "tokenNext", "sessionReturn"]) {
      expect(credentialKey(name).credential, name).toBe(false);
    }
  });
  it.each(SECRET_ROUTE_KEYS)("%s: a short value (10 characters) is strong at the top level, as a JSON leaf, in a URL parameter and in a header", (name) => {
    const short = "Ab3dEf9hJk";
    expect(tierOf(classifyString(name, short), short), "top").toBe("strong");
    expect(tierOf(classifyStorageEntry({ name: "settings", value: JSON.stringify({ [name]: short }) }), short), "leaf").toBe("strong");
    expect(tierOf(urlSecrets(`https://app.example.com/cb?${encodeURIComponent(name)}=${short}`), short), "url").toBe("strong");
    // A header name is hyphenated, as on the wire.
    const header = `x-${name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    expect(tierOf(headerSecrets([{ name: header, value: short }]), short), `header ${header}`).toBe("strong");
  });
});

describe("R4-2: names that only sound secret hold dates, URLs, paths, hosts and emails WEAK (masked, never refused); an opaque token under them stays strong", () => {
  const NAMES = ["tokenEndpoint", "authEndpoint", "authHost", "authIssuer", "authServer", "authLoginPage", "sessionEndpoint", "passwordResetLink", "secretsManagerRegion", "sessionLastActive", "tokenIssued", "sessionLastSeen", "sessionOpened", "sessionClosed", "tokenIssuer", "sessionEnded", "tokenExpires", "sessionSeen", "sessionActive", "sessionLast", "authHostname", "authEndpoints", "sessionCreated", "sessionUpdated", "sessionModified", "sessionEnd"];
  const VALUES = ["https://login.example.com/oauth2/token", "/oauth2/authorize/callback/handler", "2026-10-27T09:15:00Z", "login.example.com", "maya.rodriguez@example.com"];
  it.each(NAMES)("%s", (name) => {
    for (const value of VALUES) {
      expect(tierOf(classifyString(name, value), value), `top ${name}=${value}`).toBe("weak");
      expect(tierOf(classifyStorageEntry({ name: "settings", value: JSON.stringify({ [name]: value }) }), value), `leaf ${name}=${value}`).toBe("weak");
      expect(tierOf(classifyStorageEntry({ name, value }), value), `entry ${name}=${value}`).toBe("weak");
    }
    // A token-shaped value under the same name is still a credential.
    expect(tierOf(classifyString(name, OPAQUE), OPAQUE), `opaque ${name}`).toBe("strong");
    expect(tierOf(classifyStorageEntry({ name: "settings", value: JSON.stringify({ [name]: OPAQUE }) }), OPAQUE), `opaque leaf ${name}`).toBe("strong");
  });
  it("the same metadata under a real credential word is still a credential key, and a short date is not registered at all", () => {
    expect(credentialKey("accessToken").credential).toBe(true);
    expect(tierOf(classifyString("sessionToken", "https://login.example.com/oauth2/token"), "https://login.example.com/oauth2/token")).toBe("strong");
    expect(classifyString("tokenIssued", "2026-10-27")).toEqual([]);
  });
});

describe("R4-3: a digit-less random token that is not strong is weak (masked), as a whole value and as a JSON leaf under a neutral key; ordinary text is not", () => {
  function digitless(bytes: number, count: number, make: (raw: Buffer) => string): string[] {
    const out: string[] = [];
    while (out.length < count) { const token = make(randomBytes(bytes)).replace(/=+$/, ""); if (!/[0-9]/.test(token)) out.push(token); }
    return out;
  }
  it.each([[24, 150], [32, 60], [40, 30]])("random %i-byte base64 and base64url tokens with no digit (%i of each): weak in at least 90%% of the sample, never strong, never unregistered at the top level", (bytes, count) => {
    // The sample is only the tokens with no digit (the rest are opaque runs and strong); 0.5% of 24-byte tokens are of this kind, so it is built by rejection.
    let weakLeaf = 0;
    let total = 0;
    for (const token of [...digitless(bytes, count, (raw) => raw.toString("base64")), ...digitless(bytes, count, (raw) => raw.toString("base64url")), ...digitless(bytes, count, (raw) => `/${raw.toString("base64")}`)]) {
      total += 1;
      expect(tierOf(classifyString("anything", token), token), `top ${token}`).not.toBe("strong");
      expect(tierOf(classifyString("anything", token), token), `top ${token}`).toBe("weak");
      const leaf = tierOf(classifyStorageEntry({ name: "settings", value: JSON.stringify({ anything: token }) }), token);
      expect(leaf, `leaf ${token}`).not.toBe("strong");
      if (leaf === "weak") weakLeaf += 1;
    }
    expect(weakLeaf / total).toBeGreaterThanOrEqual(0.9);
  }, 120_000);
  it("a fixed digit-less token is weak as a JSON leaf under a neutral key and under a neutral URL-free entry", () => {
    const token = "kQwErTyUiOpAsDfGhJkLzXcVbNmQwErT";
    expect(tierOf(classifyStorageEntry({ name: "settings", value: JSON.stringify({ anything: token }) }), token)).toBe("weak");
    expect(tierOf(classifyStorageEntry({ name: "settings", value: JSON.stringify({ a: { b: [token] } }) }), token)).toBe("weak");
  });
  it("ordinary words, identifiers, slugs, paths, URLs, hosts and emails are NOT registered as JSON leaves (B-1: they must not corrupt reports or fail runs)", () => {
    const ordinary = ["userProfileSettingsManager", "NotificationPreferencesPanel", "internationalizationAndLocalization", "getUserProfileById", "SomeVeryLongComponentName", "BackgroundSyncServiceWorker",
      "Reports/Sales/Summary/Final/Report", "/Users/Shared/Documents/Projects", "my_quarterly_Report_for_Board", "this-is-an-ordinary-slug-of-many-words", "https://app.example.com/orders/overview",
      "maya.rodriguez@example.com", "login.example.com", "UPPERCASELONGCONSTANTNAMEHERE",
      // Consonant-heavy pieces that the share and vowel lines alone would call random: the slug rule and the path rule are what keep them out.
      "Qwe-Pqe-Dfa-Hje-Lzo-Cvu-Nmi-Wra-Xye-Rtz", "Pqe/Rta/Xwo/Zyl/Mnu/Cvb/Dfe/Ghi", "alllowercaselongwordsrunningtogether", "Quarterly report for ACME"];
    for (const value of ordinary) {
      expect(isDigitlessRandomToken(value), value).toBe(false);
      expect(tierOf(classifyStorageEntry({ name: "settings", value: JSON.stringify({ anything: value }) }), value), `leaf ${value}`).toBeNull();
    }
  });
});
