import { describe, expect, it } from "vitest";
import { MAYA, OMAR, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { URL_BASE, signedInClient } from "../support/mcp-broker-client.js";



describe("hand off a task from an AI tool and move on (US1)", () => {

  it("tells another developer the task was not found (US1 scenario 6)", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const maya = await signedInClient(harness, MAYA);
    const taskId = String((await maya.tool("agentx_start_task", { project: "payments", instructions: "x" })).value.task_id);
    const omar = await signedInClient(harness, OMAR);
    expect(await omar.tool("agentx_get_task", { task_id: taskId })).toMatchObject({ isError: true, error: { code: "TASK_NOT_FOUND" } });
    omar.expectNoTokenLeaked();
  });


  it("answers SIGN_IN_REQUIRED with the exact command when this computer has no sign-in", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { tool } = await signedInClient(harness, undefined);
    expect(await tool("agentx_list_projects")).toMatchObject({ isError: true, error: { code: "SIGN_IN_REQUIRED", next_step: `run npx @preplabsai/rovara-code login ${URL_BASE}` } });
    // The server keeps answering after a sign-in error: it does not crash.
    expect(await tool("agentx_whoami")).toMatchObject({ isError: true, error: { code: "SIGN_IN_REQUIRED" } });
  });
});




