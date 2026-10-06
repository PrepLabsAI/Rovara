// The setup page on this computer, for trying `agentx init --setup-table` before the bootstrap
// stack exists: it serves the same handler the setup page's function will (setup-handler.ts),
// against a real setup table, on 127.0.0.1.
//
//   npx tsx scripts/setup-page-dev.ts --env scratch --table agentx-setup-dev [--port 8780] [--create-table]
//
// Then, in another terminal, run the installer against the same table:
//
//   node packages/cli/dist/bin.js --env scratch init --region us-east-1 --release <dir> \
//     --setup-table agentx-setup-dev --setup-url http://127.0.0.1:8780
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { parseArgs } from "node:util";
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, UpdateTimeToLiveCommand, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { setupPageHandler } from "../packages/cli/src/init/ui/setup-handler.js";
import { dynamoSetupStore } from "../packages/cli/src/init/ui/setup-store.js";

const { values } = parseArgs({
  options: {
    env: { type: "string" },
    table: { type: "string" },
    port: { type: "string", default: "8780" },
    "create-table": { type: "boolean", default: false },
  },
});
if (values.env === undefined || values.table === undefined) {
  console.error("usage: npx tsx scripts/setup-page-dev.ts --env <env> --table <name> [--port 8780] [--create-table]");
  process.exit(2);
}
const env = values.env;
const table = values.table;
const port = Number(values.port);
const client = new DynamoDBClient({});

if (values["create-table"]) await ensureTable(client, table);

const token = randomBytes(32).toString("base64url");
const origin = `http://127.0.0.1:${port}`;
const handle = setupPageHandler({ store: dynamoSetupStore({ client, table, env }), env, origin, auth: { kind: "token", token } });

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", origin);
    const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value[0] : value]));
    const result = await handle({
      method: request.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), headers,
      ...(request.method === "POST" ? { body: await readBody(request) } : {}),
    });
    response.writeHead(result.status, { ...result.headers, ...(result.cookies === undefined ? {} : { "set-cookie": result.cookies }) });
    response.end(result.body);
  })().catch((error: unknown) => {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(`${error instanceof Error ? error.name : "error"}\n`);
  });
});
server.listen(port, "127.0.0.1", () => {
  console.error(`The setup page for ${env} (table ${table}) is at ${origin}/?t=${token}`);
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function ensureTable(dynamo: DynamoDBClient, name: string): Promise<void> {
  try {
    await dynamo.send(new DescribeTableCommand({ TableName: name }));
    return;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "ResourceNotFoundException") throw error;
  }
  await dynamo.send(new CreateTableCommand({
    TableName: name, BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
  }));
  await waitUntilTableExists({ client: dynamo, maxWaitTime: 120 }, { TableName: name });
  await dynamo.send(new UpdateTimeToLiveCommand({ TableName: name, TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true } }));
  console.error(`Created table ${name}`);
}
