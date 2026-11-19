// R2-F1 review round 4 (DEC 254zzz80): the dispatcher's own task-person State reads (taskPersonRuntimePorts), on a fake table. For a NAMED company the person's grants and
// the team's channel bindings are read from the company's own partition only: a legacy row is never read, and a row in the partition that names another company is dropped.
import { describe, expect, it } from "vitest";
import { taskPersonRuntimePorts } from "../../packages/broker/src/aws/dispatcher.js";
import { createTaskAuthorityAdmission } from "../../packages/broker/src/aws/task-authority-admission.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const A = `org_${"a".repeat(20)}`, B = `org_${"b".repeat(20)}`;
const DEV = "d".repeat(64);
const grant = (pk: string, project: string, extra: Record<string, unknown> = {}) => ({ pk, sk: `PROJECT#${project}`, projectName: project, role: "developer", ...extra });
const binding = (pk: string, channelId: string, extra: Record<string, unknown> = {}) => ({ pk, sk: `CHANNEL#${channelId}`, teamId: "T0PEOPLE1", channelId, projectName: "payments", updatedAt: "2026-11-18T00:00:00.000Z", ...extra });

function world() {
  const db = new FakeDynamoDb();
  db.set(grant(`ORG#${B}#MEMBER#${DEV}`, "payments"));
  db.set(grant(`MEMBER#${DEV}`, "payments-legacy"));
  db.set(grant(`ORG#${B}#MEMBER#${DEV}`, "payments-drift", { companyId: A }));
  db.set(binding(`ORG#${B}#SLACK_BINDING#T0PEOPLE1`, "C0OWN"));
  db.set(binding("SLACK_BINDING#T0PEOPLE1", "C0LEGACY"));
  db.set(binding(`ORG#${B}#SLACK_BINDING#T0PEOPLE1`, "C0DRIFT", { orgId: A }));
  const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
  const ports = taskPersonRuntimePorts({ admission, stateTableName: "state", signInTableName: "signin", proofArn: "task-person-proof", slackTeamId: "T0PEOPLE1" },
    { send: async (command: never) => db.send(command) });
  return { ports, admission };
}

describe("the dispatcher's task-person reads for a named company", () => {
  it("grants: B's own partition only; the legacy row is ignored and a row naming another company is dropped", async () => {
    const w = world();
    const read = await w.ports.projectAuthorityReader.memberships(DEV, w.admission, w.admission.admitStateRead(), B);
    expect(read).toEqual({ complete: true, items: [grant(`ORG#${B}#MEMBER#${DEV}`, "payments")] });
    // Golden: no company reads the legacy partition as before.
    const legacy = await w.ports.projectAuthorityReader.memberships(DEV, w.admission, w.admission.admitStateRead());
    expect(legacy.items).toEqual([grant(`MEMBER#${DEV}`, "payments-legacy")]);
  });

  it("channel bindings: B's own partition only; the legacy row is ignored and a row naming another company is dropped", async () => {
    const w = world();
    const read = await w.ports.projectAuthorityReader.bindings("T0PEOPLE1", w.admission, w.admission.admitStateRead(), B);
    expect(read).toEqual({ complete: true, items: [binding(`ORG#${B}#SLACK_BINDING#T0PEOPLE1`, "C0OWN")] });
    const legacy = await w.ports.projectAuthorityReader.bindings("T0PEOPLE1", w.admission, w.admission.admitStateRead());
    expect(legacy.items).toEqual([binding("SLACK_BINDING#T0PEOPLE1", "C0LEGACY")]);
  });
});
