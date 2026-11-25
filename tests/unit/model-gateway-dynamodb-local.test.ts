// The gateway's DynamoDB adapters against DynamoDB Local in Docker (as tests/unit/cloud-stores.test.ts runs Cloud's stores):
// the real service's expression parser, transactions, ClientRequestToken and index behaviour. Skipped when Docker is not
// running. Loopback only (http://127.0.0.1:<port>); no AWS call. Not under denyNetwork: it needs the loopback socket.
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { DynamoPriceSnapshotStore } from "../../packages/model-gateway/src/dynamo-prices.js";
import { GATEWAY_LEDGER_INDEXES } from "../../packages/model-gateway/src/deploy.js";
import { runMeterConformance, runMeterDeadlineConformance } from "../../packages/model-gateway/src/meter.js";

const IMAGE = "amazon/dynamodb-local:2.6.1";
const docker = (() => { try { execFileSync("docker", ["info"], { stdio: "ignore" }); return true; } catch { return false; } })();
if (!docker) console.warn("model-gateway-dynamodb-local.test.ts: Docker isn't running, so the gateway's DynamoDB adapters are not tested on DynamoDB Local here.");

describe.skipIf(!docker)("gateway DynamoDB adapters on DynamoDB Local", () => {
  let container = "";
  let endpoint = "";
  let made = 0;
  const db = () => new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "local", secretAccessKey: "local" }), endpoint });
  async function tables(): Promise<{ meter: string; ledger: string; markers: string; prices: string }> {
    const suffix = String(made++);
    const names = { meter: `meter-${suffix}`, ledger: `ledger-${suffix}`, markers: `markers-${suffix}`, prices: `prices-${suffix}` };
    for (const [kind, name] of Object.entries(names)) {
      const indexes = kind === "ledger" ? Object.values(GATEWAY_LEDGER_INDEXES) : [];
      const definitions = [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }, ...[...new Set(indexes.flatMap((index) => [index.partitionKey, index.sortKey]))].map((attribute) => ({ AttributeName: attribute, AttributeType: "S" }))];
      await createTable({ TableName: name, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: definitions, KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
        ...(indexes.length === 0 ? {} : { GlobalSecondaryIndexes: indexes.map((index) => ({ IndexName: index.name, KeySchema: [{ AttributeName: index.partitionKey, KeyType: "HASH" }, { AttributeName: index.sortKey, KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } })) }) });
    }
    return names;
  }
  async function createTable(input: Record<string, unknown>): Promise<void> {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "DynamoDB_20120810.CreateTable", authorization: "AWS4-HMAC-SHA256 Credential=local/20260101/us-west-2/dynamodb/aws4_request, SignedHeaders=host, Signature=0" }, body: JSON.stringify(input) });
    if (response.status !== 200) throw new Error(`create table failed: ${String(response.status)}`);
  }

  beforeAll(async () => {
    container = execFileSync("docker", ["run", "-d", "--rm", "-p", "127.0.0.1::8000", IMAGE, "-jar", "DynamoDBLocal.jar", "-inMemory"], { encoding: "utf8" }).trim();
    const port = execFileSync("docker", ["port", container, "8000/tcp"], { encoding: "utf8" }).trim().split(":").at(-1)!;
    endpoint = `http://127.0.0.1:${port}/`;
    for (let i = 0; i < 50; i++) { try { await fetch(endpoint); break; } catch { await new Promise((resolve) => setTimeout(resolve, 200)); } }
  }, 60_000);
  afterAll(() => { if (container !== "") execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }); });

  it("the meter passes its contract and its deadline contract on the real expression engine", async () => {
    const meterTables: Array<Awaited<ReturnType<typeof tables>>> = [];
    for (let i = 0; i < 8; i++) meterTables.push(await tables());
    let next = 0;
    expect(await runMeterConformance((clock) => new DynamoMeter({ db: db(), tables: meterTables[next++]!, now: clock }))).toContain("atomic hold");
    expect(await runMeterDeadlineConformance((clock, beforeWrite) => new DynamoMeter({ db: db(), tables: meterTables[next++]!, now: clock, beforeWrite }))).toHaveLength(4);
  }, 60_000);

  it("two servers racing for the last room in a cap take one hold", async () => {
    const names = await tables();
    const scope = { iss: "https://install.example/v1/auth", cid: `org_${"a".repeat(20)}`, pid: "web", tid: "task_1" };
    const caps = { task: 100, projectMonth: 100, companyMonth: 100 };
    const results = await Promise.all([1, 2, 3].map(() => new DynamoMeter({ db: db(), tables: names }).reserve({ scope, caps, estimateMicros: 60 })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  }, 30_000);

  it("the price store round-trips a snapshot and refuses a stale writer", async () => {
    const names = await tables();
    const store = new DynamoPriceSnapshotStore(db(), names.prices);
    const snapshot = { version: 1, sources: { litellm: { fetchedAt: 1, count: 1, entries: [{ provider: "openai" as const, model: "m", kind: "chat" as const, inputMicrosPerMTok: 1, outputMicrosPerMTok: 2 }] } } };
    expect(await store.save(snapshot, 0)).toBe(true);
    expect(await store.save({ ...snapshot }, 0)).toBe(false);
    expect(await store.load()).toEqual(snapshot);
  }, 30_000);
});
