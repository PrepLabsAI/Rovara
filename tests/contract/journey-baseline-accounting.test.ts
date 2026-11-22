import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createCoreBrowserBroker, JOURNEY_COMPANY, journeyProjectDefinition } from "../support/core-browser-journey.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";

describe("core browser journey fixture", () => {
  it("composes all hosted application seams and verification on the production root", async () => {
    const harness = await createCoreBrowserBroker();
    const seams = harness.runtime.flow.deps.applicationE2E;
    expect(seams).toBeDefined();
    expect(harness.runtime.flow.deps.e2e).toBe(seams!.rounds.verification);
    expect(typeof seams!.planning.context).toBe("function");
    expect(typeof seams!.results.read).toBe("function");
    expect(typeof seams!.publication).toBe("function");
  });
  it("starts through the real hosted core entry and writes its own engine stamp", async () => {
    const harness = await createCoreBrowserBroker();
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Add an orders export", workflow: true, workflowPath: "QUICK" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const task = response.body.task as { taskId: string; workspaceId: string };
    expect(harness.db.get(`TASK_ENGINE#${task.taskId}`, "STAMP")).toMatchObject({ coreEngine: { engine: "core", areas: { flow: "core", build: "core", merge: "core" } } });
    const stored = harness.db.get(`DEVTASK#${task.taskId}`, "META")!;
    expect(stored.companyId).toBe(JOURNEY_COMPANY);
    expect(harness.db.get(`ORG#${JOURNEY_COMPANY}#WORKSPACE#${String(stored.workspaceId)}`, "META")).toBeDefined();
    const before = JSON.stringify([...harness.db.items.values()]);
    for (const [method, path, body] of [["GET", `/v1/dev/tasks/${task.taskId}`, undefined], ["POST", `/v1/dev/tasks/${task.taskId}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: 0, instructions: "Do not accept another company's action" }]] as const) {
      expect((await harness.dev(OMAR, method, path, body)).status).toBe(404);
    }
    expect(JSON.stringify([...harness.db.items.values()])).toBe(before);
  });

  it("uses one table for core port writes and hosted document-client writes", async () => {
    const harness = await createCoreBrowserBroker();
    const key = { pk: "FIXTURE#shared-store", sk: "META" };
    await harness.runtime.flow.deps.store.put({ item: { ...key, entityType: "FIXTURE", revision: 1 } });
    expect(harness.db.get(key.pk, key.sk)?.revision).toBe(1);
    await harness.db.send(new UpdateCommand({ TableName: "state", Key: key, UpdateExpression: "SET revision = :next", ExpressionAttributeValues: { ":next": 2 } }));
    expect((await harness.runtime.flow.deps.store.get(key))?.revision).toBe(2);
    const membership = { pk: `COMPANY_MEMBER#${MAYA.developerId}`, sk: "COMPANY" };
    expect(await harness.runtime.flow.deps.store.get(membership), "State has no shadow sign-in authority").toBeUndefined();
    expect(await harness.db.send(new GetCommand({ TableName: "signin", Key: membership }))).toMatchObject({ Item: { companyId: JOURNEY_COMPANY } });
  });

  it("keeps canonical JSON bytes and JPEG bytes intact across core and hosted object readers", async () => {
    const harness = await createCoreBrowserBroker();
    const objects = (await harness.core.app.registry()).require("object-storage");
    const json = Buffer.from('{"scenarios":[],"required":true}');
    await objects.put("journey/display.json", json, { contentType: "application/json", metadata: {}, retention: "evidence-std" });
    expect(harness.s3.objects.get("journey/display.json")).toBe(json.toString("utf8"));
    expect(Buffer.from((await objects.get("journey/display.json", 1000))!)).toEqual(json);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]);
    await objects.put("journey/screenshot.jpg", jpeg, { contentType: "image/jpeg", metadata: { kind: "screenshot" }, retention: "evidence-std" });
    expect(harness.s3.binary.get("journey/screenshot.jpg")).toEqual(jpeg);
    expect(Buffer.from((await objects.get("journey/screenshot.jpg", 1000))!)).toEqual(jpeg);
    expect(await objects.stat("journey/screenshot.jpg")).toMatchObject({ bytes: jpeg.byteLength, metadata: { kind: "screenshot" } });
  });

  it("disables baseline only for contract-only bases and preserves the results fixture's default", async () => {
    const harness = await createCoreBrowserBroker();
    const definition = (await harness.runtime.flow.deps.projects.latest("payments"))!.definition;
    expect(journeyProjectDefinition(definition, false).developerTasks?.e2eBaselineRound).toBe(false);
    expect(journeyProjectDefinition(definition, true)).toBe(definition);
    expect(journeyProjectDefinition(definition, true).developerTasks?.e2eBaselineRound).toBeUndefined();
  });
});
