import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ProjectDefinitionSchema, type ProjectDefinition } from "@agentx/contracts";
import { z } from "zod";

const base = "ee25daffed9f59e7c979477c6f0b5a05834c32e3";
const image = z.string().regex(/^944937319445\.dkr\.ecr\.us-east-1\.amazonaws\.com\/charterarc-team-tasks-worker@sha256:[a-f0-9]{64}$/);
const InputSchema = z.object({
  imageUri: image,
  branchCommit: z.literal(base),
  runtimeObservation: z.object({
    account: z.literal("944937319445"), region: z.literal("us-east-1"),
    runtimeName: z.literal("charterarc_team_tasks_worker"), status: z.literal("READY"), imageUri: image,
  }).strict(),
}).strict();
export type TeamTasksProjectInput = z.infer<typeof InputSchema>;
export type RuntimeObservation = TeamTasksProjectInput["runtimeObservation"];

/** Validates read-only observations; callers must refresh them immediately before admission. */
export function buildTeamTasksProject(input: unknown): ProjectDefinition {
  const value = InputSchema.parse(input);
  if (value.imageUri !== value.runtimeObservation.imageUri) throw new Error("runtime image mismatch");
  const command = (args: string[]) => ({ cwd: "repo/team-tasks", executable: "/opt/team-tasks/bin/app-env", args, timeoutSeconds: 900 });
  return ProjectDefinitionSchema.parse({
    schemaVersion: 2, name: "charterarc-team-tasks", revision: 1,
    controlPlaneUrl: "https://3m38w35kz2.execute-api.us-east-1.amazonaws.com",
    auth: {
      issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_o1RxnoU3F",
      clientId: "3g88n9e4bj16k70rrrb026gn1d", audience: "3g88n9e4bj16k70rrrb026gn1d",
    },
    environment: { image: value.imageUri },
    repositories: [{ name: "team-tasks", url: "https://github.com/PrepLabsAI/charterarc-integration-demo.git", path: "repo/team-tasks", defaultBranch: "codex/agentx-demo-baseline", credentialRef: "github-charterarc-demo" }],
    setup: [command(["/opt/team-tasks/bin/prepare-app.sh", base])],
    readiness: [
      command(["make", "baseline"]),
      command(["node", "/opt/team-tasks/check-workspace.mjs", "/mnt/workspace", "838860800"]),
      command(["sh", "-c", 'test "$(git rev-parse HEAD)" = "$1"', "base-check", base]),
    ],
    orchestratorInstructions: "Use only the remote Team Tasks workspace. Run application tools through /opt/team-tasks/bin/app-env; keep the worker on Node 22. Implement only the approved job scope. Report checks and uncertainty as executor claims, never independently qualified evidence. No push, PR, merge or deployment without explicit authorization. This is a synthetic internal demo with time-limited preview storage, not production durability. Do not reset or rebase an existing workspace to conceal a base mismatch.",
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("usage: tsx scripts/team-tasks-project.ts observed-input.json");
  const input: unknown = JSON.parse(await readFile(process.argv[2]!, "utf8"));
  process.stdout.write(`${JSON.stringify(buildTeamTasksProject(input), null, 2)}\n`);
}
