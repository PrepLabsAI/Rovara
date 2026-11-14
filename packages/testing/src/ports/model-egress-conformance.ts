// The conformance suite every `model-egress` adapter must pass: the fake adapter world (`model-egress-world.ts`) in this lane, Code's laptop adapter (TE-F1c) and Cloud's function adapter (TE-F1e) later (DECISIONS 150(c)).
//
// A world is the adapter under test, a window on the provider side (the injected transport: every request it was given, and a way to script its answers), and what the suite needs to plant and to read back: two companies that share
// the raw ids of their sources, their keys, their meters. The suite proves, through the adapter's own port and never by reading its source: the stream shape; that a source of another company answers exactly as a missing one;
// that a call reaches no host but the row's (the injected transport asserts the destination: this is the port-level share of the required "no request reaches a real model host" test; the helper and network halves are F1-b and F1-g);
// that no inbound credential reaches the transport and exactly one, the company's own, does; that a planted key never comes back in an answer, a header, an error or a log; that a warm adapter never reuses one company's token for
// another; that one company's calls never move another's meter; that caps refuse in the family's own error shape and send nothing; that a call is attempted once. The two-company kit (`twoCompanyChecks`) runs on top.
import { expect } from "vitest";
import {
  MODEL_EGRESS_REFUSAL_HEADER, SIGV4_NOT_RUN_SENTENCE, buildOutboundRequest, maxOutputFieldOf, countCredentials, e2eSecretSpellings, parseModelEgressFrame, type ModelEgress, type ModelEgressConnection, type ModelEgressEvent, type ModelEgressRow, type ModelEgressScope,
  type ModelEgressSettle,
} from "@agentx/contracts";
import { COMPANY_A, COMPANY_B, TWO_COMPANIES, attempt, otherCompany, twoCompanyChecks, type IsolationCompany, type IsolationSurface, type TwoCompanyIsolation } from "../isolation/two-company.js";
import { assertNoSecretLeaks } from "../isolation/leaks.js";
import type { ContractCheck } from "./plugin-contract-kit.js";
import type { FakeBehaviour } from "./model-egress-fake.js";

/** The provider side of the world: every request the transport was given, and a way to script what it answers next. */
export interface ModelEgressProviderWindow {
  /** Requests as the transport received them (the credentials in them are the adapter's own placement). */
  readonly calls: ReadonlyArray<{ readonly host: string; readonly method: string; readonly path: string; readonly query: string; readonly headers: ReadonlyArray<readonly [string, string]>; readonly body: Uint8Array }>;
  script(...behaviours: FakeBehaviour[]): void;
  reset(): void;
}

export type BrokenScopeMode = "throws" | "undefined" | "empty" | "no_company";
export const BROKEN_SCOPE_MODES: readonly BrokenScopeMode[] = ["throws", "undefined", "empty", "no_company"];

export interface ModelEgressWorld {
  readonly adapter: ModelEgress;
  /** One row per family the adapter serves, by id. A `bedrock` row, if present, is served by nothing. */
  readonly rows: Readonly<Record<string, ModelEgressRow>>;
  /** The connection of the Vertex source, when there is a Vertex row. */
  readonly connection: ModelEgressConnection;
  /** Both companies have a source with each row's id (the SHARED raw id), each with its own key. */
  scope(company: IsolationCompany, sourceId: string): ModelEgressScope;
  /**
   * A scope as it is when the adapter's company resolution is broken: `throws` (reading it throws), `undefined` (no scope at all), `empty` (an object with nothing in it), `no_company` (a source but no company). REQUIRED for a world
   * whose adapter serves more than one company: with no such hook the "fails closed" check FAILS, it does not skip.
   */
  brokenScope?(mode: BrokenScopeMode): ModelEgressScope;
  /** A source only `company` owns (it serves the first served row of `rows`). */
  privateSource(company: IsolationCompany): string;
  /** What the adapter must place in a request for `company` on the source named for `rowId`: its key, or the token minted for it. */
  credentialOf(company: IsolationCompany, rowId: string): string;
  /** The planted keys of a company (what must never come back). */
  keysOf(company: IsolationCompany): readonly string[];
  readonly provider: ModelEgressProviderWindow;
  /** Micro-dollars settled on a company's meter. */
  meterOf(company: IsolationCompany): Promise<number>;
  /** Sets the cap of every source of a company. */
  setCap(company: IsolationCompany, micros: number): Promise<void>;
  /** Everything the adapter logged, as text. */
  logs(): readonly string[];
  /** The two-company surfaces, built by `modelEgressIsolation(world)` (or the world's own). */
  isolation?: TwoCompanyIsolation;
}

const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const at = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((held, key) => (typeof held === "object" && held !== null ? (held as Record<string, unknown>)[key] : undefined), value);
const enc = (text: string) => new TextEncoder().encode(text);

export interface Collected {
  readonly events: readonly ModelEgressEvent[];
  readonly status: number | undefined;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: string;
  readonly bytes: Uint8Array;
  readonly settle: ModelEgressSettle | undefined;
}

export async function collect(adapter: ModelEgress, scope: ModelEgressScope, frame: unknown): Promise<Collected> {
  const events: ModelEgressEvent[] = [];
  for await (const event of adapter.forward(scope, frame as never)) events.push(event);
  const head = events.find((event) => event.kind === "head");
  const chunks = events.flatMap((event) => (event.kind === "chunk" ? [event.bytes] : []));
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { events, status: head?.status, headers: head?.headers ?? [], body: dec(bytes), bytes, settle: events.find((event): event is ModelEgressSettle => event.kind === "settle") };
}

/** A valid call for a row: the path, query and body that family's clients send. The prompt carries `prompt`, which the fake provider echoes. */
export function validFrame(row: ModelEgressRow, connection: ModelEgressConnection, prompt = "hello", over: { maxTokens?: number; headers?: Array<[string, string]> } = {}): Record<string, unknown> {
  const text = prompt;
  const max = over.maxTokens;
  let path: string;
  let query = "";
  let body: unknown;
  switch (row.family) {
    case "gemini":
      path = "/v1beta/models/fixture-small:generateContent";
      body = { contents: [{ parts: [{ text }] }], ...(max === undefined ? {} : { generationConfig: { maxOutputTokens: max } }) };
      break;
    case "vertex":
      path = `/v1/projects/${connection.vertex?.project ?? "p"}/locations/${connection.vertex?.location ?? "l"}/publishers/google/models/fixture-small:generateContent`;
      body = { contents: [{ parts: [{ text }] }], ...(max === undefined ? {} : { generationConfig: { maxOutputTokens: max } }) };
      break;
    case "anthropic_messages":
      path = "/v1/messages";
      body = { model: "fixture-small", max_tokens: max ?? 64, messages: [{ role: "user", content: text }] };
      break;
    case "cohere":
      path = "/v2/chat";
      body = { model: "fixture-small", messages: [{ role: "user", content: text }], ...(max === undefined ? {} : { max_tokens: max }) };
      break;
    default:
      if (row.azure !== undefined) {
        path = `/openai/deployments/${row.azure.deployment}/chat/completions`;
        query = `api-version=${row.azure.apiVersion}`;
      } else {
        path = "/v1/chat/completions";
      }
      body = { model: "fixture-small", messages: [{ role: "user", content: text }], ...(max === undefined ? {} : { max_tokens: max }) };
  }
  return { row: row.id, method: "POST", path, query, headers: over.headers ?? [["content-type", "application/json"]], body: enc(JSON.stringify(body)) };
}

/** A provider answer body that reports `input` input tokens and one output token, in the row's family's own shape. */
function usageBody(row: ModelEgressRow, input: number): Record<string, unknown> {
  return row.family === "gemini" || row.family === "vertex" ? { usageMetadata: { promptTokenCount: input, candidatesTokenCount: 1 } }
    : row.family === "anthropic_messages" ? { usage: { input_tokens: input, output_tokens: 1 } }
    : row.family === "cohere" ? { meta: { billed_units: { input_tokens: input, output_tokens: 1 } } }
    : { usage: { prompt_tokens: input, completion_tokens: 1 } };
}

const served = (world: ModelEgressWorld): ModelEgressRow[] => Object.values(world.rows).filter((row) => row.family !== "bedrock");
const expectedHost = (row: ModelEgressRow, connection: ModelEgressConnection): string => (row.family === "vertex" && connection.vertex !== undefined ? `${connection.vertex.location}-aiplatform.googleapis.com` : (row.hosts[0] ?? connection.host ?? ""));
const headerValue = (headers: ReadonlyArray<readonly [string, string]>, name: string): string | undefined => headers.find(([key]) => key.toLowerCase() === name)?.[1];

/** Every credential a call carries, as the provider's transport saw it: header values of credential-carrying names and the `key` query value. */
function credentialsSeen(call: ModelEgressProviderWindow["calls"][number]): string[] {
  const names = /^(authorization|x-api-key|x-goog-api-key|api-key)$/iu;
  const fromHeaders = call.headers.filter(([name]) => names.test(name)).map(([, value]) => value.replace(/^Bearer /u, ""));
  const key = call.query.split("&").map((pair) => pair.split("=")).filter(([name]) => decodeURIComponent(name ?? "").toLowerCase() === "key").map(([, value]) => decodeURIComponent(value ?? ""));
  return [...fromHeaders, ...key];
}

/** A planted inbound credential value, built at runtime (the public repository refuses key-shaped literals). */
const inb = (name: string): string => ["inbound", "secret", name].join("-");
const INBOUND_CREDENTIALS: Array<[string, string]> = [
  ["Authorization", `Bearer ${inb("authorization")}`],
  ["x-api-key", `${inb("x-api-key")}`],
  ["X-Goog-Api-Key", `${inb("goog")}`],
  ["api-key", `${inb("api-key")}`],
  ["Cookie", `sid=${inb("cookie")}`],
  ["x-goog-user-project", `${inb("project")}`],
  ["Proxy-Authorization", `${inb("proxy")}`],
  ["x-amz-security-token", `${inb("amz")}`],
];

const ownChecks: ReadonlyArray<ContractCheck<ModelEgressWorld>> = [
  {
    name: "fails closed when the company cannot be resolved from the scope: not_found, no provider call, no company's data",
    async run(world) {
      // A world that serves more than one company MUST be able to break its scope: with no hook this check fails rather than skips.
      if (world.brokenScope === undefined) {
        expect(world.isolation, "a world that serves more than one company must supply brokenScope(mode)").toBeUndefined();
        return;
      }
      const row = served(world)[0]!;
      const missing = await collect(world.adapter, world.scope(COMPANY_A, "no-such-source"), validFrame(row, world.connection, "hello"));
      for (const mode of BROKEN_SCOPE_MODES) {
        world.provider.reset();
        const answer = await collect(world.adapter, world.brokenScope(mode), validFrame(row, world.connection, `${COMPANY_A.canary} ${COMPANY_B.canary}`));
        expect(answer.status, mode).toBe(404);
        expect(answer.settle, mode).toMatchObject({ class: "refused", refusal: "not_found", costMicros: 0 });
        expect(answer.body, mode).toBe(missing.body);
        expect(world.provider.calls, `${mode}: a call reached the provider`).toHaveLength(0);
        const seen = JSON.stringify([answer.headers, answer.body]);
        for (const company of TWO_COMPANIES) {
          expect(seen.includes(company.canary), mode).toBe(false);
          expect(seen.includes(company.orgId), mode).toBe(false);
          for (const key of world.keysOf(company)) expect(seen.includes(key), mode).toBe(false);
        }
      }
    },
  },
  {
    name: "streams one head, then chunks, then exactly one settle: for an answer and for every kind of refusal",
    async run(world) {
      for (const row of served(world)) {
        const answers = [
          await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection)),
          await collect(world.adapter, world.scope(COMPANY_A, "no-such-source"), validFrame(row, world.connection)),
          await collect(world.adapter, world.scope(COMPANY_A, row.id), { ...validFrame(row, world.connection), path: "/v1/../x" }),
          await collect(world.adapter, world.scope(COMPANY_A, row.id), { ...validFrame(row, world.connection), method: "CONNECT" }),
          await collect(world.adapter, world.scope(COMPANY_A, row.id), { not: "a frame" }),
        ];
        for (const answer of answers) {
          const kinds = answer.events.map((event) => event.kind);
          expect(kinds[0], row.id).toBe("head");
          expect(kinds.at(-1), row.id).toBe("settle");
          expect(kinds.filter((kind) => kind === "head")).toHaveLength(1);
          expect(kinds.filter((kind) => kind === "settle")).toHaveLength(1);
          expect(kinds.slice(1, -1).every((kind) => kind === "chunk")).toBe(true);
          const settle = answer.settle!;
          for (const number of [settle.status, settle.costMicros]) expect(Number.isSafeInteger(number) && number >= 0).toBe(true);
        }
        expect(answers[0]!.settle!.class).toBe("ok");
        expect(answers[1]!.settle!.refusal).toBe("not_found");
        expect(answers[2]!.settle!.refusal).toBe("bad_request");
        expect(answers[3]!.settle!.refusal).toBe("not_allowed");
        expect(answers[4]!.settle!.refusal).toBe("bad_request");
      }
    },
  },
  {
    name: "answers a source that is another company's exactly as it answers one that does not exist, and calls no provider",
    async run(world) {
      const row = served(world)[0]!;
      world.provider.reset();
      const frame = validFrame(row, world.connection);
      const missing = await collect(world.adapter, world.scope(COMPANY_A, "no-such-source"), frame);
      const foreign = await collect(world.adapter, world.scope(COMPANY_A, world.privateSource(COMPANY_B)), frame);
      const foreignBack = await collect(world.adapter, world.scope(COMPANY_B, world.privateSource(COMPANY_A)), frame);
      expect(foreign.status).toBe(missing.status);
      expect(foreign.headers).toEqual(missing.headers);
      expect(foreign.body).toBe(missing.body);
      expect(foreign.settle).toEqual(missing.settle);
      expect(foreignBack.body).toBe(missing.body);
      expect(missing.settle?.refusal).toBe("not_found");
      expect(world.provider.calls).toHaveLength(0);
      // The words name nobody: not the company, not the source.
      for (const text of [missing.body, foreign.body]) for (const name of [COMPANY_A.orgId, COMPANY_B.orgId, world.privateSource(COMPANY_B)]) expect(text.includes(name)).toBe(false);
    },
  },
  {
    name: "sends a call to no host but the row's, whatever the frame says: the destination is checked at the transport",
    async run(world) {
      for (const row of served(world)) {
        // One row at a time: every call of THIS row's frames must go to THIS row's host (a call that reaches some other row's host carries this row's key there).
        world.provider.reset();
        const base = validFrame(row, world.connection);
        const hostile: Array<Record<string, unknown>> = [
          base,
          { ...base, headers: [["Host", "evil.example.test"], ["X-Forwarded-Host", "evil.example.test"], ["Forwarded", "host=evil.example.test"], [":authority", "evil.example.test"], ["content-type", "application/json"]] },
          { ...base, path: "http://evil.example.test/v1/chat/completions" },
          { ...base, path: "//evil.example.test/v1/chat/completions" },
          { ...base, path: `${String(base.path)}@evil.example.test` },
          { ...base, path: "/v1/chat/completions\r\nHost: evil.example.test" },
          { ...base, query: "url=https://evil.example.test" },
        ];
        for (const frame of hostile) await collect(world.adapter, world.scope(COMPANY_A, row.id), frame);
        // Exactly two frames per row are well-formed (the plain one and the one with hostile host headers, which are dropped): nothing else got through.
        expect(world.provider.calls, row.id).toHaveLength(2);
        for (const call of world.provider.calls) {
          expect(call.host, `row ${row.id} sent a call to ${call.host}`).toBe(expectedHost(row, world.connection));
          expect(call.host).not.toContain("evil");
          expect(JSON.stringify([call.path, call.query, call.headers])).not.toContain("evil.example.test");
          expect(call.method).toBe("POST");
          expect(call.path.startsWith("/")).toBe(true);
        }
      }
    },
  },
  {
    name: "drops every inbound credential and places exactly one, the company's own",
    async run(world) {
      for (const company of TWO_COMPANIES) {
        for (const row of served(world)) {
          world.provider.reset();
          const frame = validFrame(row, world.connection, "hi", { headers: [...INBOUND_CREDENTIALS, ["content-type", "application/json"]] });
          const answer = await collect(world.adapter, world.scope(company, row.id), { ...frame, query: `${String(frame.query)}${frame.query === "" ? "" : "&"}key=${inb("query")}` });
          expect(answer.settle?.class, `${row.id}: ${answer.body}`).toBe("ok");
          expect(world.provider.calls).toHaveLength(1);
          const call = world.provider.calls[0]!;
          const everything = JSON.stringify([call.host, call.path, call.query, call.headers]);
          expect(everything.includes(inb("")), everything).toBe(false);
          const seen = credentialsSeen(call);
          expect(seen, `${row.id} for ${company.label}`).toEqual([world.credentialOf(company, row.id)]);
          expect(countCredentials({ headers: call.headers, query: call.query })).toBe(1);
        }
      }
    },
  },
  {
    name: "never gives a planted key back: not in an answer, a header, an error or a log, in any spelling",
    async run(world) {
      for (const company of TWO_COMPANIES) {
        const other = otherCompany(company);
        for (const row of served(world)) {
          const key = world.credentialOf(company, row.id);
          const planted = [...world.keysOf(company), key];
          const spellings = planted.flatMap((value) => e2eSecretSpellings(value));
          const behaviours: FakeBehaviour[] = [{ echoCredential: true }, { echoCredential: true, status: 400 }, { echoCredential: true, status: 401 }, { echoCredential: true, status: 403 }, { echoCredential: true, status: 500 }];
          for (const behaviour of behaviours) {
            world.provider.script(behaviour);
            const answer = await collect(world.adapter, world.scope(company, row.id), validFrame(row, world.connection));
            const seen = JSON.stringify([answer.status, answer.headers, answer.body]);
            for (const spelling of spellings) expect(seen.includes(spelling), `${row.id}: a spelling of the key came back (status ${String(behaviour.status ?? 200)})`).toBe(false);
            for (const spelling of world.keysOf(other).flatMap((value) => e2eSecretSpellings(value))) expect(seen.includes(spelling)).toBe(false);
            expect(headerValue(answer.headers, "set-cookie")).toBeUndefined();
            expect(headerValue(answer.headers, "x-echo")).toBeUndefined();
          }
          // A cut-off error answer, a streamed echo, and the refusal paths too.
          world.provider.script({ chunks: [`data: {"echo":"${key.slice(0, 20)}`, `${key.slice(20)}"}\n\n`], headers: [["content-type", "text/event-stream"]] });
          const streamed = await collect(world.adapter, world.scope(company, row.id), validFrame(row, world.connection));
          for (const spelling of spellings) expect(streamed.body.includes(spelling), "a key split across stream chunks came back").toBe(false);
        }
        assertNoSecretLeaks([world.logs().join("\n")], world.keysOf(company));
        for (const value of Object.keys(world.rows).map((id) => world.credentialOf(company, id))) expect(world.logs().join("\n").includes(value)).toBe(false);
      }
    },
  },
  {
    name: "a warm adapter serving company A then B then A never places one company's token or key for the other",
    async run(world) {
      for (const row of served(world)) {
        world.provider.reset();
        const order = [COMPANY_A, COMPANY_B, COMPANY_A, COMPANY_B, COMPANY_B, COMPANY_A];
        for (const company of order) await collect(world.adapter, world.scope(company, row.id), validFrame(row, world.connection));
        expect(world.provider.calls).toHaveLength(order.length);
        order.forEach((company, index) => {
          const seen = credentialsSeen(world.provider.calls[index]!);
          expect(seen, `${row.id}, call ${String(index)} for ${company.label}`).toEqual([world.credentialOf(company, row.id)]);
        });
        expect(world.credentialOf(COMPANY_A, row.id)).not.toBe(world.credentialOf(COMPANY_B, row.id));
      }
    },
  },
  {
    name: "one company's calls never move another company's meter",
    async run(world) {
      const row = served(world)[0]!;
      const beforeB = await world.meterOf(COMPANY_B);
      const beforeA = await world.meterOf(COMPANY_A);
      for (let index = 0; index < 3; index += 1) expect((await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection))).settle?.class).toBe("ok");
      expect(await world.meterOf(COMPANY_B)).toBe(beforeB);
      expect(await world.meterOf(COMPANY_A)).toBeGreaterThan(beforeA);
      const afterA = await world.meterOf(COMPANY_A);
      await collect(world.adapter, world.scope(COMPANY_B, row.id), validFrame(row, world.connection));
      expect(await world.meterOf(COMPANY_A)).toBe(afterA);
      expect(await world.meterOf(COMPANY_B)).toBeGreaterThan(beforeB);
    },
  },
  {
    name: "refuses past the cap with a 429 in the family's own error shape, names the cap, and sends nothing to the provider",
    async run(world) {
      for (const row of served(world)) {
        await world.setCap(COMPANY_A, 1);
        world.provider.reset();
        const answer = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection, "hi", { maxTokens: 100_000 }));
        expect(answer.status, row.id).toBe(429);
        expect(headerValue(answer.headers, MODEL_EGRESS_REFUSAL_HEADER)).toBe("cap");
        expect(answer.settle).toMatchObject({ class: "cap", refusal: "cap", costMicros: 0 });
        const parsed: unknown = JSON.parse(answer.body);
        const shapes: Record<string, boolean> = {
          openai_compatible: typeof at(parsed, "error", "message") === "string" && at(parsed, "error", "code") === "rovara_cap",
          anthropic_messages: at(parsed, "type") === "error" && at(parsed, "error", "type") === "rate_limit_error",
          gemini: at(parsed, "error", "code") === 429 && at(parsed, "error", "status") === "RESOURCE_EXHAUSTED",
          vertex: at(parsed, "error", "code") === 429 && at(parsed, "error", "status") === "RESOURCE_EXHAUSTED",
          cohere: typeof at(parsed, "message") === "string",
        };
        expect(shapes[row.family], `${row.id}: ${answer.body}`).toBe(true);
        expect(answer.body).toContain("per task");
        expect(world.provider.calls).toHaveLength(0);
        await world.setCap(COMPANY_A, 1_000_000_000);
      }
    },
  },
  {
    name: "sets the row's default maximum output when the request names none, so the provider's limit is the reserved number",
    async run(world) {
      for (const row of served(world)) {
        world.provider.reset();
        await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection));
        const sent: unknown = JSON.parse(dec(world.provider.calls[0]!.body));
        const field = maxOutputFieldOf(row);
        const limit = row.family === "gemini" || row.family === "vertex" ? at(sent, "generationConfig", "maxOutputTokens") : row.family === "anthropic_messages" ? at(sent, "max_tokens") : row.family === "cohere" ? at(sent, "max_tokens") : at(sent, field);
        // Anthropic's `max_tokens` is the client's own (the family requires it); every other family gets the row's default.
        expect(limit, row.id).toBe(row.family === "anthropic_messages" ? 64 : row.defaultMaxOutputTokens);
        // A limit the client set is the client's.
        world.provider.reset();
        await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection, "hi", { maxTokens: 33 }));
        const own: unknown = JSON.parse(dec(world.provider.calls[0]!.body));
        expect(row.family === "gemini" || row.family === "vertex" ? at(own, "generationConfig", "maxOutputTokens") : at(own, "max_tokens"), row.id).toBe(33);
        expect(at(own, "max_completion_tokens"), `${row.id}: a limit the client set is not duplicated`).toBeUndefined();
      }
    },
  },
  {
    name: "reserves for a request that names a file or cached content as if it were large, and refuses it when the cap cannot hold that",
    async run(world) {
      const row = served(world).find((candidate) => candidate.family === "gemini" || candidate.family === "vertex")!;
      const frame = validFrame(row, world.connection);
      const withFile = (key: "fileData" | "cachedContent"): Record<string, unknown> => {
        const body = JSON.parse(dec(frame.body as Uint8Array)) as Record<string, unknown>;
        const marked = key === "fileData" ? { ...body, contents: [{ parts: [{ fileData: { fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc", mimeType: "video/mp4" } }] }] } : { ...body, cachedContent: "cachedContents/abc" };
        return { ...frame, body: enc(JSON.stringify(marked)) };
      };
      for (const key of ["fileData", "cachedContent"] as const) {
        // The same request body without the file is small and cheap: only the reference makes the reservation large.
        await world.setCap(COMPANY_A, 200_000);
        world.provider.reset();
        const plain = await collect(world.adapter, world.scope(COMPANY_A, row.id), frame);
        expect(plain.settle?.class, "a small plain request fits a small cap").toBe("ok");
        const refused = await collect(world.adapter, world.scope(COMPANY_A, row.id), withFile(key));
        expect(refused.status, key).toBe(429);
        expect(refused.settle, key).toMatchObject({ class: "cap", refusal: "cap", costMicros: 0 });
        expect(world.provider.calls, `${key}: the provider must not be called`).toHaveLength(1);
        await world.setCap(COMPANY_A, 1_000_000_000);
        const allowed = await collect(world.adapter, world.scope(COMPANY_A, row.id), withFile(key));
        expect(allowed.settle?.class, key).toBe("ok");
      }
    },
  },
  {
    name: "after a call takes the SPEND past the cap the task takes no further call: 'budget exceeded by one call'",
    async run(world) {
      for (const row of served(world)) {
        world.provider.reset();
        // A cap the reservation fits in, and a settle far above it: the one call the cap may be overrun by.
        await world.setCap(COMPANY_A, 2_000_000);
        world.provider.script({ body: JSON.stringify(usageBody(row, 50_000_000)) });
        const first = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection));
        expect(first.settle, row.id).toMatchObject({ class: "ok", overrun: true });
        const second = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection));
        expect(second.status, row.id).toBe(429);
        expect(second.settle, row.id).toMatchObject({ class: "cap", refusal: "cap", costMicros: 0 });
        expect(second.body).toContain("budget exceeded by one call");
        expect(world.provider.calls, `${row.id}: the second call must not reach the provider`).toHaveLength(1);
        await world.setCap(COMPANY_A, 1_000_000_000);
        // Another company's task is unaffected.
        expect((await collect(world.adapter, world.scope(COMPANY_B, row.id), validFrame(row, world.connection))).settle?.class).toBe("ok");
      }
    },
  },
  {
    name: "a call that costs more than its estimate but leaves the spend under the cap does not block the task",
    async run(world) {
      for (const row of served(world)) {
        world.provider.reset();
        await world.setCap(COMPANY_A, 50_000_000);
        // Well above the reservation of a small request (a few hundred micro-dollars), far under a $50 cap.
        world.provider.script({ body: JSON.stringify(usageBody(row, 20_000)) });
        const first = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection));
        expect(first.settle?.class, row.id).toBe("ok");
        expect(first.settle?.overrun, row.id).toBeUndefined();
        expect(first.settle!.costMicros, `${row.id}: the call must cost more than a small estimate`).toBeGreaterThan(1_000);
        const second = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection));
        expect(second.settle?.class, `${row.id}: the next call must be allowed`).toBe("ok");
        expect(world.provider.calls).toHaveLength(2);
        await world.setCap(COMPANY_A, 1_000_000_000);
      }
    },
  },
  {
    name: "makes one attempt: no retry after a fault, a 5xx or a 429",
    async run(world) {
      for (const row of served(world)) {
        for (const behaviour of [{ fault: true }, { status: 503, body: "{}" }, { status: 500, body: "{}" }, { status: 429, body: "{}" }] as FakeBehaviour[]) {
          world.provider.reset();
          world.provider.script(behaviour, {}, {});
          const answer = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection));
          expect(world.provider.calls, `${row.id} ${JSON.stringify(behaviour)}`).toHaveLength(1);
          expect(answer.events.at(-1)?.kind).toBe("settle");
          expect(answer.status).toBe(behaviour.fault === true ? 502 : behaviour.status);
        }
      }
    },
  },
  {
    name: "gives a provider 429 and 5xx back unchanged, with the class for the evidence",
    async run(world) {
      const row = served(world)[0]!;
      const cases: Array<[number, string, string]> = [[429, JSON.stringify({ error: { type: "rate_limit_error", code: "rate_limit_exceeded" } }), "rate_limit"], [429, JSON.stringify({ error: { code: "insufficient_quota" } }), "quota"], [529, JSON.stringify({ error: { type: "overloaded_error" } }), "overloaded"]];
      for (const [status, body, cls] of cases) {
        world.provider.script({ status, body, headers: [["content-type", "application/json"], ["retry-after", "7"]] });
        const answer = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection));
        expect(answer.status).toBe(status);
        expect(answer.body).toBe(body);
        expect(headerValue(answer.headers, "retry-after")).toBe("7");
        expect(headerValue(answer.headers, MODEL_EGRESS_REFUSAL_HEADER)).toBeUndefined();
        expect(answer.settle?.class).toBe(cls);
      }
    },
  },
  {
    name: "never follows or passes on a provider redirect: the answer is the fixed refusal, with no location",
    async run(world) {
      for (const row of served(world)) {
        world.provider.reset();
        world.provider.script({ status: 302, headers: [["location", "http://evil.example.test/steal"], ["content-type", "text/html"]], body: "<a href=http://evil.example.test>moved</a>" }, {});
        const answer = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection));
        expect(world.provider.calls, row.id).toHaveLength(1);
        expect(answer.status, row.id).toBe(502);
        expect(headerValue(answer.headers, "location")).toBeUndefined();
        expect(headerValue(answer.headers, MODEL_EGRESS_REFUSAL_HEADER)).toBe("ssrf");
        expect(answer.settle).toMatchObject({ class: "refused", refusal: "ssrf", costMicros: 0 });
        expect(answer.body).not.toContain("evil.example.test");
      }
    },
  },
  {
    name: "sends back only allow-listed response headers",
    async run(world) {
      const row = served(world)[0]!;
      world.provider.script({ headers: [["content-type", "application/json"], ["set-cookie", "a=b"], ["openai-organization", "org-1"], ["x-rovara-refusal", "cap"], ["x-request-id", "req-1"], ["server", "x"]] });
      const answer = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection));
      expect(answer.headers.map(([name]) => name.toLowerCase()).sort()).toEqual(["content-type", "x-request-id"]);
      expect(answer.settle?.class).toBe("ok");
    },
  },
  {
    name: "settles to the provider's reported usage, and a cut-off stream keeps its reservation (the meter errs high)",
    async run(world) {
      const row = served(world)[0]!;
      const before = await world.meterOf(COMPANY_A);
      const whole = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection, "hi", { maxTokens: 4000 }));
      expect(whole.settle).toMatchObject({ class: "ok", inputTokens: 10, outputTokens: 5, estimated: false });
      const settledWhole = (await world.meterOf(COMPANY_A)) - before;
      expect(settledWhole).toBe(whole.settle!.costMicros);
      const mid = await world.meterOf(COMPANY_A);
      world.provider.script({ chunks: ["data: {\"par"], headers: [["content-type", "text/event-stream"]], cutOff: true });
      const cut = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection, "hi", { maxTokens: 4000 }));
      expect(cut.settle).toMatchObject({ estimated: true });
      expect(cut.settle!.costMicros).toBeGreaterThan(whole.settle!.costMicros);
      expect((await world.meterOf(COMPANY_A)) - mid).toBe(cut.settle!.costMicros);
    },
  },
  {
    name: "refuses what the core refuses: a path off the allow list or a query it does not know reaches no provider",
    async run(world) {
      for (const row of served(world)) {
        world.provider.reset();
        const base = validFrame(row, world.connection);
        for (const frame of [{ ...base, path: "/v1/files" }, { ...base, path: "/v1/models" }, { ...base, query: "access_token=x" }, { ...base, method: "GET" }, { ...base, path: "/%2e%2e/etc" }]) {
          const answer = await collect(world.adapter, world.scope(COMPANY_A, row.id), frame);
          expect(["not_allowed", "bad_request"], row.id).toContain(answer.settle?.refusal);
        }
        expect(world.provider.calls).toHaveLength(0);
      }
    },
  },
  {
    name: "answers a Bedrock or SigV4 row with the not-run sentence and calls no provider",
    needs: (world) => Object.values(world.rows).some((row) => row.family === "bedrock"),
    async run(world) {
      const row = Object.values(world.rows).find((candidate) => candidate.family === "bedrock")!;
      world.provider.reset();
      const parsed = parseModelEgressFrame({ row: row.id, method: "POST", path: "/model/m/converse", query: "", headers: [], body: enc("{}") });
      if (!parsed.ok) throw new Error("the Bedrock test frame must be well-formed");
      const answer = await collect(world.adapter, world.scope(COMPANY_A, row.id), { row: row.id, method: "POST", path: "/model/m/converse", query: "", headers: [], body: enc("{}") });
      expect(answer.status).toBeGreaterThanOrEqual(400);
      expect(answer.settle?.class).toBe("refused");
      expect(world.provider.calls).toHaveLength(0);
      expect(buildOutboundRequest(row, world.connection, parsed.frame, "a-secret-value").ok).toBe(false);
      expect(SIGV4_NOT_RUN_SENTENCE).toContain("TE-F6");
    },
  },
];

/**
 * The two-company surfaces for a world: a company's prompt comes back to that company only; a company's key never reaches the other (the meters are checked by their own check). Both companies share the raw source ids. A real adapter's world may
 * supply its own `isolation` instead.
 */
export function modelEgressIsolation(world: ModelEgressWorld): TwoCompanyIsolation {
  const row = served(world)[0]!;
  const surfaces: IsolationSurface[] = [
    {
      kind: "read",
      name: "an answer carries the caller's own prompt only, from a source whose id both companies use",
      async plant(me) {
        return { handle: undefined, markers: [me.canary, ...world.keysOf(me)] };
      },
      async observe(as) {
        const own = await collect(world.adapter, world.scope(as, row.id), validFrame(row, world.connection, as.canary));
        const other = otherCompany(as);
        const stranger = await attempt(() => collect(world.adapter, world.scope(as, world.privateSource(other)), validFrame(row, world.connection, as.canary)));
        return { own: own.body, stranger: stranger.ok ? (stranger.value as Collected).body : stranger.refused };
      },
    },
    {
      kind: "secret",
      name: "a provider that echoes the key it was given gives it back to no company",
      expectOwn: false,
      async plant(me) {
        return { handle: undefined, markers: [...world.keysOf(me)] };
      },
      async observe(as) {
        world.provider.script({ echoCredential: true });
        const answer = await collect(world.adapter, world.scope(as, row.id), validFrame(row, world.connection, as.canary));
        return { answer: answer.body, headers: answer.headers, logs: world.logs().join("\n") };
      },
    },
  ];
  return { surfaces };
}

export const modelEgressChecks: readonly ContractCheck<ModelEgressWorld>[] = [...ownChecks, ...twoCompanyChecks<ModelEgressWorld>()];
