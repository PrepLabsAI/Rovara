// Operator entrypoint: one bounded page, default preview. Run only through the operator guard, in staging (us-west-2) or production (us-east-1, #1300).
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, type GetCommand } from "@aws-sdk/lib-dynamodb";
import { catalogBackfill } from "./project-catalog-backfill.js";
import { backfillCorePage, checkCorePeople } from "./core-project-backfill.js";
import { operatorRegion } from "./legacy-install-move.js";

export function parseCoreBackfillArguments(args: string[]) {
  const values = new Map<string, string>(); let dryRun = true, peopleCheck = false, mode: "migrate-incarnations" | undefined, action: "discover" | "verify" | "unmark" | "undo-run" | undefined, mark = false;
  const refused = () => new Error("core backfill arguments refused");
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--migrate-incarnations") { if (mode !== undefined) throw refused(); mode = "migrate-incarnations"; continue; }
    if (flag === "--mark") { if (mark) throw refused(); mark = true; continue; }
    if (["--discover", "--verify", "--unmark", "--undo-run"].includes(flag)) {
      if (action !== undefined) throw refused();
      action = flag.slice(2) as "discover" | "verify" | "unmark" | "undo-run";
      if (action === "unmark" || action === "undo-run") {
        if (values.has("--run-id")) throw refused();
        const runId = args[++index]; if (runId === undefined || !/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw refused(); values.set("--run-id", runId);
      }
      continue;
    }
    if (flag === "--apply") { if (!dryRun) throw refused(); dryRun = false; continue; }
    if (flag === "--people-check") { if (peopleCheck) throw refused(); peopleCheck = true; continue; }
    if (!["--state-table", "--signin-table", "--input", "--continuation", "--run-id"].includes(flag) || values.has(flag)) throw refused();
    const value = args[++index];
    if (value === undefined || value.startsWith("--") || value.length > 2048) throw refused();
    values.set(flag, value);
  }
  const tableName = values.get("--state-table"), signInTableName = values.get("--signin-table"), file = values.get("--input");
  if ((mode !== undefined && (peopleCheck || action !== undefined || mark)) || !tableName || !signInTableName || !file || !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName) || !/^[A-Za-z0-9_.-]{3,255}$/.test(signInTableName) || (peopleCheck && (!dryRun || action !== undefined || mark)) || (mark && action !== "verify") || (action === "discover" && !dryRun) || (values.has("--run-id") && !/^[A-Za-z0-9_-]{1,100}$/.test(values.get("--run-id")!))) throw refused();
  return { tableName, signInTableName, file, dryRun, peopleCheck, mode, continuation: values.get("--continuation"), action, mark, runId: values.get("--run-id") };
}
export async function readCoreMappingFile(path: string): Promise<Record<string, unknown>> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65_536) throw new Error("refused");
    const buffer = Buffer.alloc(65_537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65_536) throw new Error("refused");
    const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("refused");
    return value as Record<string, unknown>;
  } catch { throw new Error("core backfill input refused"); }
  finally { await file?.close(); }
}
async function main() {
  const args = parseCoreBackfillArguments(process.argv.slice(2));
  const region = operatorRegion(process.env, "core backfill region refused");
  const signal = AbortSignal.timeout(5000);
  const mapping = await readCoreMappingFile(args.file);
  signal.throwIfAborted();
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 1 }));
  const deps = { tableName: args.tableName, signInTableName: args.signInTableName, documentClient: { send: (command: unknown) => client.send(command as GetCommand, { abortSignal: signal }) } };
  try {
    const result = args.action !== undefined ? await catalogBackfill(deps, { ...mapping, action: args.action, mark: args.mark, dryRun: args.dryRun,
      ...(args.runId === undefined ? {} : { runId: args.runId }), ...(args.continuation === undefined ? {} : { continuation: args.continuation }) }) : args.peopleCheck ? await checkCorePeople(deps, mapping)
      : await backfillCorePage(deps, { ...mapping, ...(args.mode === undefined ? {} : { mode: args.mode }), dryRun: args.dryRun, ...(args.runId === undefined ? {} : { runId: args.runId }), ...(args.continuation === undefined ? {} : { continuation: args.continuation }) });
    if (args.action === "discover" && "mappings" in result && result.ok) {
      for (const [index, input] of (result.mappings ?? []).entries()) {
        const output = await open(join(dirname(args.file), `catalog-${input.companyId}-${createHash("sha256").update(`${args.tableName}/${args.continuation ?? "start"}`).digest("hex").slice(0, 16)}-${index}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await output.writeFile(`${JSON.stringify(input)}\n`); } finally { await output.close(); }
      }
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (("ok" in result && !result.ok) || ("refused" in result && result.refused !== undefined) || ("failed" in result && result.failed)) process.exitCode = 1;
  } finally { client.destroy(); }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => { process.stderr.write("core backfill unavailable\n"); process.exitCode = 1; });
}
