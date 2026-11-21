// Operator entrypoint (#1300): move the legacy install's Slack workspace or one GitHub App installation between the built-in company and one named company. One move per run,
// a preview unless `--apply` is given, and one side of every move is the built-in company (moveSlackWorkspace, moveGithubInstallation), so no run can move a named company's
// binding to another named company. The projects themselves move with the project backfill (core-backfill-runner.ts). Run from a built worktree with the operator's own
// credentials, for example:
//   AWS_REGION=us-east-1 node packages/broker/dist/aws/legacy-install-move.js --state-table <table> --slack-team <team> --from <company> --to <company> --by operator.move
//   AWS_REGION=us-east-1 node packages/broker/dist/aws/legacy-install-move.js --state-table <table> --github-installation <id> --from <company> --to <company> --by operator.move --apply
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { moveGithubInstallation } from "./github-credentials.js";
import { moveSlackWorkspace } from "./slack-workspace-binding.js";

/** The regions an operator run may reach: production and the teammate's staging. */
export const LEGACY_MOVE_REGIONS: readonly string[] = ["us-east-1", "us-west-2"];

export type LegacyMoveArguments =
  | { kind: "slack"; tableName: string; teamId: string; from: string; to: string; by: string; apply: boolean }
  | { kind: "github"; tableName: string; installationId: number; from: string; to: string; by: string; apply: boolean };

/** The fixed refusal for any argument list that is not exactly one move. */
export const LEGACY_MOVE_ARGUMENTS_REFUSED = "legacy install move arguments refused";

export function parseLegacyMoveArguments(args: readonly string[]): LegacyMoveArguments {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--apply") { if (apply) throw new Error(LEGACY_MOVE_ARGUMENTS_REFUSED); apply = true; continue; }
    if (!["--state-table", "--slack-team", "--github-installation", "--from", "--to", "--by"].includes(flag) || values.has(flag)) throw new Error(LEGACY_MOVE_ARGUMENTS_REFUSED);
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(LEGACY_MOVE_ARGUMENTS_REFUSED);
    values.set(flag, value);
  }
  const tableName = values.get("--state-table"), from = values.get("--from"), to = values.get("--to"), by = values.get("--by");
  const team = values.get("--slack-team"), installation = values.get("--github-installation");
  if (tableName === undefined || !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName) || from === undefined || to === undefined || by === undefined || (team === undefined) === (installation === undefined)) {
    throw new Error(LEGACY_MOVE_ARGUMENTS_REFUSED);
  }
  if (team !== undefined) return { kind: "slack", tableName, teamId: team, from, to, by, apply };
  if (!/^[1-9][0-9]{0,15}$/.test(installation!)) throw new Error(LEGACY_MOVE_ARGUMENTS_REFUSED);
  return { kind: "github", tableName, installationId: Number(installation), from, to, by, apply };
}

async function main(): Promise<void> {
  const args = parseLegacyMoveArguments(process.argv.slice(2));
  const region = process.env["AWS_REGION"] ?? "";
  if (!LEGACY_MOVE_REGIONS.includes(region)) throw new Error("legacy install move region refused");
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 1 }));
  try {
    const result = args.kind === "slack"
      ? await moveSlackWorkspace({ client, tableName: args.tableName }, { teamId: args.teamId, from: args.from, to: args.to, by: args.by, apply: args.apply })
      : await moveGithubInstallation({ client, tableName: args.tableName }, { installationId: args.installationId, from: args.from, to: args.to, by: args.by, apply: args.apply });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { client.destroy(); }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => { process.stderr.write("legacy install move refused\n"); process.exitCode = 1; });
}
