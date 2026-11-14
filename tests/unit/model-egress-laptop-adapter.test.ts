// TE-F1c: what is specific to the LAPTOP adapter (the conformance suite covers the port): the destination guard, the forwarder's refusal as an answer, the rebinding case end to end, an unreadable key file, and the key never
// reaching a log, a file other than the key store, or an answer.
import { chmodSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { e2eSecretSpellings } from "@agentx/contracts";
import { installNetworkTripwire, type NetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
import { collect, validFrame } from "../../packages/testing/src/ports/model-egress-conformance.js";
import { FIXTURE_AZURE_HOST } from "../../packages/testing/src/ports/model-egress-fixtures.js";
import { EgressSsrfError, createLaptopTransport } from "../../packages/broker/src/local/model-egress/forwarder.js";
import { createLaptopModelEgress, hostAllowedForRow } from "../../packages/broker/src/local/model-egress/adapter.js";
import { PRODUCT_KEYS_FILE_NAME, createProductKeyStore } from "../../packages/broker/src/local/model-egress/key-store.js";
import { createLocalMeter } from "../../packages/broker/src/local/model-egress/meter.js";
import { COMPANY_A, laptopWorld, type LaptopWorld } from "./model-egress-laptop-support.js";

let tripwire: NetworkTripwire;
const worlds: LaptopWorld[] = [];
beforeEach(() => { tripwire = installNetworkTripwire(); });
afterEach(() => { tripwire.restore(); worlds.splice(0).forEach((world) => world.cleanup()); expect(tripwire.attempts).toEqual([]); });
const make = async (options: Parameters<typeof laptopWorld>[0] = {}) => { const world = await laptopWorld(options); worlds.push(world); return world; };

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
