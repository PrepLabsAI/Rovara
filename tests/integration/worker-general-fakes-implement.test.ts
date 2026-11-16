// General fakes slice 2 (DEC 234): the coding run's own verification (`workflowMode: "IMPLEMENT"` with readiness) answers the project's outside calls with Rovara-made fakes when the broker sent `generalFakes`, labels
// the check on the report itself ("Made by Rovara", never proof), and says so in the run's events. Without the payload the run is exactly as it was. Real Pi session on the faux model, the real check runners, the local shell.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CheckReportSchema, GENERAL_FAKE_NOT_RUN_SENTENCES, GENERAL_FAKES_LOCAL_ONLY_SENTENCE, type GeneralFakesPayload, type ProjectCommand, type WorkerInvocation } from "@agentx/contracts";
import type { WorkerArtifact } from "../../packages/worker/src/artifacts.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import { createDefaultPiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const SPEC = JSON.stringify({ openapi: "3.0.3", info: { title: "pay", version: "1" }, paths: { "/charges/{id}": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { paid: { type: "boolean" } } } } } } } } } } });
const CALL = "const base = process.env.PAY_URL ?? 'https://pay.invalid'; fetch(base + process.argv[1]).then(async (r) => { const b = await r.json(); console.log('paid=' + b.paid); process.exit(b.paid === true ? 0 : 1); }, () => { console.log('unreachable'); process.exit(2); });";
const check = (path: string): ProjectCommand => ({ executable: process.execPath, args: ["-e", CALL, path], cwd: "app", timeoutSeconds: 20 });
const CODER: FauxResponseStep[] = [
  fauxAssistantMessage([fauxToolCall("write", { path: "app/notes.md", content: "note\n" }, { id: "write-1" })], { stopReason: "toolUse" }),
  fauxAssistantMessage("Wrote a note.\nAgentX result: done"),
];

/** A workspace whose manifest names one committed repository, `app`, holding the service's OpenAPI description. */
async function workspace(prepared: ProjectCommand[]): Promise<string> {
  const rootPath = await createFixtureDirectory("agentx-gf-implement-");
  await mkdir(join(rootPath, ".agentx"));
  const repositoryPath = join(rootPath, "app");
  await mkdir(repositoryPath);
  await writeFile(join(repositoryPath, "openapi.json"), SPEC);
  execFileSync("git", ["init", "-q", repositoryPath]);
  const git = (...args: string[]) => execFileSync("git", ["-C", repositoryPath, "-c", "user.name=AgentX Test", "-c", "user.email=test@example.invalid", ...args], { encoding: "utf8" }).trim();
  git("add", "."); git("commit", "-qm", "fixture");
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "verify", projectRevision: 1, repositories: [{ name: "app", path: "app", defaultBranch: "main", resolvedCommit: git("rev-parse", "HEAD"), resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
    completedSetupSteps: [], readinessResults: [], readinessCommandKeys: prepared.map((command) => `${command.cwd}\u0000${command.executable}\u0000${command.args.join("\u0000")}`), creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString(),
  }));
  return rootPath;
}

async function codingRun(readiness: ProjectCommand[], generalFakes?: GeneralFakesPayload) {
  const { modelRuntime, faux } = await fauxModelRuntime({});
  faux.setResponses(CODER);
  const piAdapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
  const invocation: Extract<WorkerInvocation, { kind: "task" }> = {
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "fix it", workflowMode: "IMPLEMENT", readiness, ...(generalFakes === undefined ? {} : { generalFakes }) },
  };
  const events: WorkerEvent[] = [];
  const artifacts: WorkerArtifact[] = [];
  const result = await runTaskInvocation(invocation, { rootPath: await workspace(readiness), model: FAUX_MODEL, piAdapter, eventSink: async (batch) => { events.push(...batch); }, artifactSink: async (artifact) => { artifacts.push(artifact); } });
  const content = artifacts.find((artifact) => artifact.name === "checks.json")?.content;
  return { result, events: JSON.stringify(events), report: content === undefined ? undefined : CheckReportSchema.parse(JSON.parse(String(content))) };
}

describe("general fakes in the coding run's own verification", () => {
  it("the check's call gets the fake's answer; the report's entry is labelled Made by Rovara and the run says so", async () => {
    const { report, events } = await codingRun([check("/charges/ch_1")], { services: [{ variable: "PAY_URL" }] });
    expect(report?.checks[0]).toMatchObject({ after: "passed", madeByRovara: true });
    expect(report?.checks[0]?.output).toContain("paid=true");
    expect(events).toContain("Made by Rovara: 1 outside call in this check round was answered by fakes Rovara made from your OpenAPI description. They never count as change proof.");
  });

  it("a failed check after a call the fake cannot answer is Not run with the reason", async () => {
    const { report } = await codingRun([check("/refunds/r_1")], { services: [{ variable: "PAY_URL" }] });
    expect(report?.checks[0]).toMatchObject({ after: "not_run", output: GENERAL_FAKE_NOT_RUN_SENTENCES.operation_unknown });
    expect(report?.checks[0]).not.toHaveProperty("madeByRovara");
  });

  it("without the payload the run is unchanged: no fake, no label, the call fails as before (golden)", async () => {
    const { report, events } = await codingRun([check("/charges/ch_1")]);
    expect(report?.checks[0]).toMatchObject({ after: "failed" });
    expect(report?.checks[0]?.output).toContain("unreachable");
    expect(report?.checks[0]).not.toHaveProperty("madeByRovara");
    expect(events).not.toContain("Made by Rovara");
    expect(events).not.toContain(GENERAL_FAKES_LOCAL_ONLY_SENTENCE);
  });
});
