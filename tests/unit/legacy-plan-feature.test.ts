import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { IMPLICIT_COMPANY_ID, reportTaskFeatureKey, type WorkflowSnapshot } from "@agentx/contracts";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";

it.each(["tracker", "chosen", "none", "fault"])("legacy task-page/Slack common writer confirms best effort: %s", async (kind) => {
  const h = await createSingleAnswerPlanBroker();
  // The legacy fake speaks document commands; bridge the generic store's wire commands to the same fake table.
  const send = h.db.send.bind(h.db);
  h.db.send = async (command) => {
    if (command.constructor.name === "GetItemCommand") {
      if (kind === "fault") throw new Error("private canary");
      const result = await send(new GetCommand({ ...command.input, TableName: command.input.TableName as string, Key: unmarshall(command.input.Key as never) }));
      const item = (result as { Item?: Record<string, unknown> }).Item;
      return item === undefined ? {} : { Item: marshall(item) };
    }
    if (command.constructor.name === "TransactWriteItemsCommand") {
      const actions = (command.input.TransactItems as Array<Record<string, Record<string, unknown>>>).map((action) => Object.fromEntries(Object.entries(action).map(([name, fields]) => [name, { ...fields, ...(fields.Key === undefined ? {} : { Key: unmarshall(fields.Key as never) }), ...(fields.Item === undefined ? {} : { Item: unmarshall(fields.Item as never) }), ...(fields.ExpressionAttributeValues === undefined ? {} : { ExpressionAttributeValues: unmarshall(fields.ExpressionAttributeValues as never) }) }])));
      return send(new TransactWriteCommand({ TransactItems: actions }));
    }
    return send(command);
  };
  const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix retries", client: "test", workflow: true, workflowPath: "QUICK" });
  const taskId = (started.body.task as { taskId: string }).taskId;
  const task = h.db.get(`DEVTASK#${taskId}`, "META")!;
  const workspaceId = task.workspaceId as string;
  const operations = () => h.db.find((row) => row.pk === `WORKSPACE#${workspaceId}` && row.entityType === "OPERATION");
  await h.finish(workspaceId, operations().find((row) => row.kind === "prepare")!.id as string, "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
  const plan = "# Plan\n\nFix retries and add a regression test.\n";
  await finishPlanningWithMarkdown(h, workspaceId, operations().find((row) => row.workflowMode === "PLAN")!.id as string, plan);
  const key = reportTaskFeatureKey(IMPLICIT_COMPANY_ID, taskId);
  const source = kind === "tracker" || kind === "fault" ? "tracker" : "chosen";
  h.db.set({ ...key, entityType: "REPORT_TASK_FEATURE", companyId: IMPLICIT_COMPANY_ID, taskId, project: "payments", featureId: kind === "none" ? null : "ft_aaaaaaaaaaaaaaaaaaaa", source, version: 1, setAt: new Date().toISOString() });
  const workflow = h.db.get(`DEVTASK#${taskId}`, "META")!.workflow as WorkflowSnapshot;
  const result = await h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: createHash("sha256").update(plan).digest("hex") });
  expect(result.status).toBe(200);
  expect(h.db.get(key.pk, key.sk)).toMatchObject({ source: kind === "tracker" ? "confirmed_at_plan" : source, featureId: kind === "none" ? null : "ft_aaaaaaaaaaaaaaaaaaaa" });
  if (kind === "tracker") expect(h.db.find((row) => row.entityType === "AUDIT" && row.action === "report.task_feature_set")).toEqual([expect.objectContaining({ actor: { type: "person", id: MAYA.developerId } })]);
});
