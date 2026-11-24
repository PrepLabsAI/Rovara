// S1-T0: the Slack Stop button on a core task, pressed through the REAL interactivity dispatcher with the hosted wiring (the task row from the broker's table, the broker's real task authorization, the registry's press handler,
// the broker's own `core-task-action` event into the core), not through the broker event the older test drives. What a person gets is judged by the outcome: whether the core's step was cancelled and whether the stop was recorded.
//
// Written FIRST and red against code/next 4204774e0: the old dispatcher sent `agentx_workflow_stop` to the workflow handler, whose `authorize` (the broker's `resolveTaskAccess`) refuses a core task, so the owner and an administrator
// were told "Only the task owner can stop this task." (the broker logged `workflow.authorize_failed` with TASK_NOT_FOUND) and the core's cancel was never called: no step stopped and no `task.stop_requested` row existed.
import { beforeAll, describe, expect, it } from "vitest";
import { loadSlackBroker } from "../support/slack-broker.js";
import { SLACK_PEOPLE, coreSlackWorld, hostedPressDispatcher, slackPress } from "../support/core-slack-world.js";

beforeAll(async () => { await loadSlackBroker(); });

const pressStop = async (userId: string, actionId = "agentx_workflow_stop") => {
  const world = await coreSlackWorld();
  world.shareThread();
  const dispatcher = hostedPressDispatcher(world);
  const value = actionId === "agentx_workflow_stop" ? { taskId: world.task.taskId } : { t: world.task.taskId, r: 0 };
  await dispatcher.press(slackPress({ actionId, value: JSON.stringify(value), userId }));
  const recorded = world.world.audit.filter((event) => event.action === "task.stop_requested");
  return { world, dispatcher, recorded, status: await world.status() };
};

describe("the Slack Stop button on a core task, pressed through the real interactivity dispatcher", () => {
  it.each(["agentx_workflow_stop", "rovara_task:task.stop"])("stops the running step for its owner (%s) and records it as Slack's", async (actionId) => {
    const { dispatcher, recorded, status } = await pressStop(SLACK_PEOPLE.owner, actionId);
    expect({ status, recorded: recorded.length }).toEqual({ status: "CANCELLED", recorded: 1 });
    expect(recorded[0]).toMatchObject({ details: { via: "slack", by: "owner" } });
    // The card says it once, in place; nothing is said in the channel or privately as a refusal.
    expect(dispatcher.updates).toHaveLength(1);
    expect(dispatcher.said).toEqual([]);
  });

  it("stops it for a live administrator of the task's company, as the core's own rule allows, with no confirm dialog", async () => {
    const { dispatcher, recorded, status } = await pressStop(SLACK_PEOPLE.admin);
    expect({ status, recorded: recorded.length }).toEqual({ status: "CANCELLED", recorded: 1 });
    expect(recorded[0]).toMatchObject({ details: { by: "company-admin", via: "slack" } });
    expect(dispatcher.views.filter((view) => view.method === "views.open")).toEqual([]);
  });

  it("refuses a colleague, another company's administrator and an unknown person, privately; nothing is stopped or recorded and the channel hears nothing", async () => {
    for (const who of [SLACK_PEOPLE.colleague, SLACK_PEOPLE.foreign, "U0NOBODY001"]) {
      const { dispatcher, recorded, status } = await pressStop(who);
      expect({ who, recorded: recorded.length, cancelled: status === "CANCELLED" }, who).toEqual({ who, recorded: 0, cancelled: false });
      expect(dispatcher.said, who).toHaveLength(1);
      expect(dispatcher.updates, who).toEqual([]);
    }
  });
});
