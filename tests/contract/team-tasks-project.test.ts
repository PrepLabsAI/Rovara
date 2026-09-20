import { ProjectDefinitionSchema } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { buildTeamTasksProject } from "../../scripts/team-tasks-project.js";
const imageUri = `944937319445.dkr.ecr.us-east-1.amazonaws.com/charterarc-team-tasks-worker@sha256:${"a".repeat(64)}`;
const valid = { imageUri, branchCommit: "ee25daffed9f59e7c979477c6f0b5a05834c32e3", runtimeObservation: {
  account: "944937319445", region: "us-east-1", runtimeName: "charterarc_team_tasks_worker", status: "READY", imageUri,
} };
describe("Team Tasks project admission", () => {
  it("pins the private repository, isolated runtime image, and required checks", () => {
    const project = buildTeamTasksProject(valid);
    expect(ProjectDefinitionSchema.safeParse(project).success).toBe(true);
    expect(project.environment.image).toBe(imageUri);
    expect(project.repositories).toEqual([{ name: "team-tasks", url: "https://github.com/PrepLabsAI/charterarc-integration-demo.git", path: "repo/team-tasks", defaultBranch: "codex/agentx-demo-baseline", credentialRef: "github-charterarc-demo" }]);
    expect(project.setup[0]).toEqual({ cwd: "repo/team-tasks", executable: "/opt/team-tasks/bin/app-env", args: ["/opt/team-tasks/bin/prepare-app.sh", "ee25daffed9f59e7c979477c6f0b5a05834c32e3"], timeoutSeconds: 900 });
    expect(project.readiness.map((c) => c.args)).toEqual([
      ["make", "baseline"],
      ["node", "/opt/team-tasks/check-workspace.mjs", "/mnt/workspace", "838860800"],
      ["sh", "-c", 'test "$(git rev-parse HEAD)" = "$1"', "base-check", "ee25daffed9f59e7c979477c6f0b5a05834c32e3"],
    ]);
  });
  it.each([
    { ...valid, branchCommit: "0".repeat(40) },
    { ...valid, imageUri: imageUri.replace(/@sha256:.*/, ":latest") },
    { ...valid, imageUri: `${imageUri}\n`, runtimeObservation: { ...valid.runtimeObservation, imageUri: `${imageUri}\n` } },
    { ...valid, extra: true },
    {}, null, undefined,
    ...Object.entries({ account: "000000000000", region: "us-west-2", runtimeName: "agentx_demo_worker", status: "CREATING", imageUri: imageUri.replace(/a{64}$/, "b".repeat(64)), extra: true }).map(([k, v]) => ({ ...valid, runtimeObservation: { ...valid.runtimeObservation, [k]: v } })),
  ])("rejects invalid or mismatched admission metadata %j", (input) => {
    expect(() => buildTeamTasksProject(input)).toThrow();
  });
});
