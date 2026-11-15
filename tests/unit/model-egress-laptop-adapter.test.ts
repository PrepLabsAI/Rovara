// TE-F1c: what is specific to the LAPTOP adapter (the conformance suite covers the port): the destination guard, the forwarder's refusal as an answer, the rebinding case end to end, an unreadable key file, and the key never
// reaching a log, a file other than the key store, or an answer.
import { chmodSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { e2eSecretSpellings, evalFactsFromClasses, familyErrorBody, reserveEstimate } from "@agentx/contracts";
import { installNetworkTripwire, type NetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
import { collect, validFrame } from "../../packages/testing/src/ports/model-egress-conformance.js";
import { FIXTURE_AZURE_HOST } from "../../packages/testing/src/ports/model-egress-fixtures.js";
import { EgressSsrfError, createLaptopTransport, type LaptopHttpsRequest } from "../../packages/broker/src/local/model-egress/forwarder.js";
import { createLaptopModelEgress, hostAllowedForRow } from "../../packages/broker/src/local/model-egress/adapter.js";
import { PRODUCT_KEYS_FILE_NAME, createProductKeyStore } from "../../packages/broker/src/local/model-egress/key-store.js";
import { createLocalMeter } from "../../packages/broker/src/local/model-egress/meter.js";
import { COMPANY_A, laptopWorld, type LaptopWorld } from "./model-egress-laptop-support.js";

let tripwire: NetworkTripwire;
const worlds: LaptopWorld[] = [];
beforeEach(() => { tripwire = installNetworkTripwire(); });
afterEach(() => { vi.useRealTimers(); tripwire.restore(); worlds.splice(0).forEach((world) => world.cleanup()); expect(tripwire.attempts).toEqual([]); });
const make = async (options: Parameters<typeof laptopWorld>[0] = {}) => { const world = await laptopWorld(options); worlds.push(world); return world; };

describe("a cut-off provider body is never a partial ok", () => {
  it.each([false, true])("keeps reported usage above the reservation after a cut (streaming=%s)", async (streaming) => {
    const body = JSON.stringify({ usage: { prompt_tokens: 2_000_000, completion_tokens: 2_000_000 } });
    const world = await make({ transport: async () => ({ status: 200, headers: [["content-type", streaming ? "text/event-stream" : "application/json"]], body: (async function* () {
      yield Buffer.from(streaming ? `data: ${body}\n\n` : body);
      throw new Error("PRIVATE-PROVIDER-FAULT");
    })() }) });
    const row = world.rows.openai!;
    const answer = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection));
    expect(answer.settle).toMatchObject({ status: 502, class: "provider_error", costMicros: 1_500_000, estimated: true });
    expect(await world.meterOf(COMPANY_A)).toBe(1_500_000);
    expect(JSON.stringify([answer, world.logs()])).not.toContain("PRIVATE-PROVIDER-FAULT");
  });
  for (const streaming of [false, true]) {
    for (const cause of ["size cap", "reset", "deadline"] as const) {
      for (const cut of [false, true]) {
        it(`${streaming ? "streamed" : "buffered"} ${cause}: ${cut ? "provider error with maybe-spent cost" : "complete control stays byte-identical"}`, async () => {
          // Exercise a large body at the exact total cap and one byte past it;
          // both individual chunks fit, so a per-chunk limit would miss the cut.
          const content = "answer".repeat(cause === "size cap" ? 175_000 : 200);
          const prefix = streaming ? `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` : `{"answer":"${content}`;
          const suffix = streaming ? "data: [DONE]\n\n" : "\"}";
          const maxBytes = Buffer.byteLength(prefix + suffix);
          const seen = { calls: 0, parts: 0, received: 0, destroyed: 0 };
          let fault = "";
          // Real Node readable semantics; only HTTPS and DNS are replaced. Destroying
          // the request tears down its response, just as a deadline does on a socket.
          const request: LaptopHttpsRequest = ((_options: unknown, callback: (response: unknown) => void) => {
            seen.calls += 1;
            const response = Object.assign(Readable.from((async function* () {
              seen.parts += 1;
              yield Buffer.from(prefix);
              if (cut && cause === "reset") throw new Error(fault);
              if (cut && cause === "deadline") await vi.advanceTimersByTimeAsync(50);
              seen.parts += 1;
              yield Buffer.from(suffix);
            })()), { statusCode: 200, headers: { "content-type": streaming ? "text/event-stream" : "application/json", "x-request-id": "provider-header" } });
            const call = Object.assign(new EventEmitter(), {
              end() { queueMicrotask(() => callback(response)); },
              destroy() { seen.destroyed += 1; response.destroy(new Error(fault)); },
            });
            response.once("close", () => call.emit("close"));
            return call;
          }) as unknown as LaptopHttpsRequest;
          let inputBytes = 0;
          const transport = createLaptopTransport({ lookup: async () => ["142.250.80.42"], request, responseBytesMax: cut && cause === "size cap" ? maxBytes - 1 : maxBytes, totalMs: 50 });
          const world = await make({ transport: async (outbound, signal) => {
            inputBytes = outbound.body.byteLength;
            const response = await transport(outbound, signal);
            return { ...response, body: (async function* () { for await (const part of response.body) { seen.received += 1; yield part; } })() };
          } });
          const row = world.rows.openai!;
          const key = world.credentialOf(COMPANY_A, row.id);
          fault = `PRIVATE-FAULT-${key}`;
          const frame = validFrame(row, world.connection);
          vi.useFakeTimers();
          const answer = await collect(world.adapter, world.scope(COMPANY_A, row.id), frame);
          expect(seen.calls).toBe(1);
          expect(seen.parts).toBeGreaterThanOrEqual(1);
          expect(seen.received).toBeGreaterThanOrEqual(1);
          if (cut) {
            expect(answer.settle).toMatchObject({ status: 502, class: "provider_error", estimated: true });
            expect(evalFactsFromClasses([answer.settle!.class])).toMatchObject({ run: 0, notRun: 1, byClass: { provider_error: 1 } });
            if (!streaming) {
              expect(answer.status).toBe(502);
              expect(answer.headers).toEqual([["content-type", "application/json"]]);
              expect(answer.body).toBe(Buffer.from(familyErrorBody(row.family, 502, "The provider could not be reached.", "rovara_unreachable")).toString());
            }
            if (cause === "deadline") expect(seen.destroyed).toBe(1);
          } else {
            expect(answer.status).toBe(200);
            expect(answer.body).toBe(prefix + suffix);
            expect(answer.settle?.class).toBe("ok");
            expect(seen.parts).toBe(2);
            expect(seen.destroyed).toBe(0);
          }
          const reserve = reserveEstimate({ row, model: "fixture-small", inputBytes, maxOutputTokens: row.defaultMaxOutputTokens });
          expect(answer.settle?.costMicros).toBe(reserve.reserveMicros);
          expect(reserve.reserveMicros).toBeGreaterThan(0);
          expect(await world.meterOf(COMPANY_A)).toBe(reserve.reserveMicros);
          const printed = JSON.stringify([answer.status, answer.headers, answer.body, answer.settle, world.logs()]);
          for (const secret of ["PRIVATE-FAULT", ...e2eSecretSpellings(key)]) expect(printed).not.toContain(secret);
          expect(vi.getTimerCount()).toBe(0);
        }, 5_000);
      }
    }
  }
});

describe("the destination guard", () => {
  it("a row may call its own hosts, and an Azure row its connected resource's host under its suffix; nothing else", async () => {
    const world = await make();
    const { openai, azure, vertex } = world.rows;
    expect(hostAllowedForRow(openai!, {}, "api.openai.com")).toBe(true);
    expect(hostAllowedForRow(openai!, {}, "generativelanguage.googleapis.com")).toBe(false);
    expect(hostAllowedForRow(openai!, {}, "evil.example")).toBe(false);
    expect(hostAllowedForRow(azure!, { host: FIXTURE_AZURE_HOST }, FIXTURE_AZURE_HOST)).toBe(true);
    expect(hostAllowedForRow(azure!, { host: FIXTURE_AZURE_HOST }, "other.openai.azure.com")).toBe(false);
    expect(hostAllowedForRow(azure!, {}, FIXTURE_AZURE_HOST)).toBe(false);
    expect(hostAllowedForRow(azure!, { host: "x.evil.example" }, "x.evil.example")).toBe(false);
    expect(hostAllowedForRow(vertex!, {}, "us-central1-aiplatform.googleapis.com")).toBe(true);
    expect(hostAllowedForRow(vertex!, {}, "storage.googleapis.com")).toBe(false);
  });
});

describe("the adapter checks the destination against the row again", () => {
  it("a row whose host changes between the core's routing and the adapter's check is refused: nothing is sent", async () => {
    const world = await make();
    const real = world.rows.openai!;
    let reads = 0;
    const shifty = Object.create(real, { hosts: { enumerable: true, get: () => { reads += 1; return reads === 1 ? ["evil.example.com"] : real.hosts; } } }) as typeof real;
    const sent: string[] = [];
    const adapter = createLaptopModelEgress({
      rows: [shifty], keys: createProductKeyStore({ directory: world.directory }), meter: createLocalMeter({ directory: world.directory, now: () => 1 }),
      transport: async (request) => { sent.push(request.host); throw new Error("never answered"); },
    });
    const answer = await collect(adapter, world.scope(COMPANY_A, real.id), validFrame(real, world.connection));
    expect(answer.settle).toMatchObject({ refusal: "ssrf" });
    expect(sent).toEqual([]);
    expect(reads).toBeGreaterThan(1);
  });
});

describe("the forwarder's refusal is an answer", () => {
  it("a transport that refuses the address gives the family's ssrf refusal, a settle of zero, and no spend", async () => {
    const world = await make({ transport: async () => { throw new EgressSsrfError(); } });
    const row = world.rows.openai!;
    const answer = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection));
    expect(answer.settle).toMatchObject({ class: "refused", refusal: "ssrf", costMicros: 0 });
    expect(answer.status).toBe(502);
    expect(await world.meterOf(COMPANY_A)).toBe(0);
  });
  it("REBINDING end to end: the real forwarder with a lookup that answers public, then private: the second call reaches no host", async () => {
    const answers = [["142.250.80.42"], ["10.1.2.3"]];
    const requested: Array<Record<string, unknown>> = [];
    const transport = createLaptopTransport({
      lookup: async () => answers.shift() ?? ["10.1.2.3"],
      request: ((options: Record<string, unknown>) => { requested.push(options); throw new Error("the stub request is never answered"); }) as never,
    });
    const world = await make({ transport });
    const row = world.rows.gemini!;
    const first = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection));
    expect(first.status).toBe(502);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ host: "142.250.80.42", servername: "generativelanguage.googleapis.com" });
    const second = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection));
    expect(second.settle).toMatchObject({ refusal: "ssrf" });
    expect(requested).toHaveLength(1);
  });
  it("a private first answer is refused outright: not one connection is attempted", async () => {
    const requested: unknown[] = [];
    const transport = createLaptopTransport({ lookup: async () => ["127.0.0.1"], request: ((options: unknown) => { requested.push(options); throw new Error("no"); }) });
    const world = await make({ transport });
    for (const row of [world.rows.openai!, world.rows.anthropic!, world.rows.cohere!]) {
      const answer = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection));
      expect(answer.settle, row.id).toMatchObject({ refusal: "ssrf" });
    }
    expect(requested).toHaveLength(0);
  });
});

describe("a key file that cannot be read", () => {
  it("is a source nobody can be served from: the fixed not_found, no call, and no word of the failure", async () => {
    const world = await make();
    chmodSync(join(world.directory, PRODUCT_KEYS_FILE_NAME), 0o644);
    const row = world.rows.openai!;
    const answer = await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection));
    expect(answer.settle).toMatchObject({ refusal: "not_found" });
    expect(world.provider.calls).toHaveLength(0);
    expect(answer.body).not.toMatch(/chmod|600|readable/u);
  });
});

describe("the key stays in its own file", () => {
  it("after calls and errors it is in no log, no answer and no file but the key store", async () => {
    const world = await make();
    for (const row of world.rowsList.filter((candidate) => candidate.family !== "bedrock")) {
      world.provider.script({ echoCredential: true });
      await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection, "hello"));
      world.provider.script({ fault: true });
      await collect(world.adapter, world.scope(COMPANY_A, row.id), validFrame(row, world.connection, "again"));
    }
    const secrets = world.keysOf(COMPANY_A).flatMap((key) => e2eSecretSpellings(key));
    const printed = world.logs().join("\n");
    for (const spelling of secrets) expect(printed.includes(spelling)).toBe(false);
    for (const name of readdirSync(world.directory)) {
      if (name === PRODUCT_KEYS_FILE_NAME) continue;
      const text = readFileSync(join(world.directory, name), "utf8");
      for (const spelling of secrets) expect(text.includes(spelling), name).toBe(false);
    }
    expect(world.logs().every((line) => Object.keys(JSON.parse(line) as object).every((key) => ["event", "row", "status", "class", "refusal", "cost"].includes(key)))).toBe(true);
  });
});
