import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectDefinitionSchema } from "../../packages/contracts/src/project.js";
import { recordRegisteredLoopEnrollment } from "../../packages/cli/src/loop/enrollment-cli.js";
import { LoopStore } from "../../packages/cli/src/loop/state.js";
import type { Exec } from "../../packages/cli/src/loop/exec.js";

const dirs: string[] = [];
const definition = ProjectDefinitionSchema.parse({
  name: "payments", revision: 1,
  repositories: [{ name: "payments", url: "https://github.com/acme/payments.git", path: "repo/payments", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: "Delegate changes to the worker.",
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rovara-enrollment-cli-"));
  dirs.push(root);
  const home = join(root, "home");
  const cwd = join(root, "checkout");
  await mkdir(cwd, { recursive: true });
  const exec: Exec = async (command, args) => {
    if (command !== "gh") return { code: 1, stdout: "", stderr: "unexpected command" };
    if (args[0] === "repo" && args[1] === "view") return { code: 0, stdout: "acme/payments\n", stderr: "" };
    if (args[0] === "api" && args[1] === "user") return { code: 0, stdout: "maya\n", stderr: "" };
    if (args[0] === "api" && args[1] === "repos/acme/payments") return { code: 0, stdout: "1234\n", stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  return { root, home, cwd, exec, store: new LoopStore(join(home, ".rovara", "loop")) };
}

describe("native CLI loop enrollment producer", () => {
  it("records managed scope only after a matching successful native registration and source observation", async () => {
    const h = await fixture();
    const response = { project: { registeredBy: "owner-1", definition } };
    const result = await recordRegisteredLoopEnrollment({ home: h.home, env: "prod", controlPlaneUrl: "https://agentx.example", definition, response, cwd: h.cwd, exec: h.exec, now: new Date("2026-10-14T10:00:00.000Z") });
    expect(result).toEqual({ recorded: true, repository: "acme/payments" });
    const [receipt] = await h.store.enrollments();
    expect(receipt).toMatchObject({ kind: "registered", project: "payments", projectRevision: 1, repository: "acme/payments", repositoryId: 1234, account: "maya" });
    expect(receipt?.kind === "registered" ? receipt.sourceBindingRef : "").toMatch(/^cli-source:v1:[a-f0-9]{64}$/u);
  });

  it("does not mint a receipt when the server response or current source does not match", async () => {
    const h = await fixture();
    const noResponse = await recordRegisteredLoopEnrollment({ home: h.home, env: "prod", controlPlaneUrl: "https://agentx.example", definition, response: {}, cwd: h.cwd, exec: h.exec });
    expect(noResponse).toMatchObject({ recorded: false, reasonCode: "registration_response_unproven" });
    const mismatch = { project: { registeredBy: "owner-1", definition: { ...definition, revision: 2 } } };
    const noSource = await recordRegisteredLoopEnrollment({ home: h.home, env: "prod", controlPlaneUrl: "https://agentx.example", definition, response: mismatch, cwd: h.cwd, exec: h.exec });
    expect(noSource).toMatchObject({ recorded: false, reasonCode: "registration_response_unproven" });
    expect(await h.store.enrollments()).toEqual([]);
  });
});

afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
