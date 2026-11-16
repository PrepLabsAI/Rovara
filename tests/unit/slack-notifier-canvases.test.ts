import { expect, it, vi } from "vitest";
import * as notifier from "../../packages/broker/src/aws/developer-task-notifier.js";
import { slackTokens } from "../../packages/testing/src/channel/slack-world.js";
const A = { companyId: "org_aaaaaaaaaaaaaaaaaaaa", teamId: "T0AAAAAAA" };
const B = { companyId: "org_bbbbbbbbbbbbbbbbbbbb", teamId: "T0BBBBBBB" };
it("notifier Canvas creation, sharing, reads and deletion use the task's workspace token", async () => {
  const legacy = vi.fn(async () => slackTokens("legacy").bot);
  const calls: string[] = [];
  const transport: typeof fetch = async (_url, init) => {
    calls.push(new Headers(init?.headers).get("authorization")!);
    return Response.json({ ok: true, canvas_id: "F12345678", file: { permalink: "https://example.slack.com/docs/F12345678" } });
  };
  expect(typeof notifier.createNotifierCanvasDelivery).toBe("function");
  const delivery = notifier.createNotifierCanvasDelivery(legacy, {
    requireCompany: async (team) => team === A.teamId ? A.companyId : B.companyId,
    tokenForCompany: async (company) => slackTokens(company === A.companyId ? "a" : "b").bot,
  }, transport);
  for (const workspace of [A, B]) {
    await delivery.create({ workspace, channel: "C0SHARED01", taskId: "same-task", title: "Plan", version: 1, markdown: "A plan" });
    await delivery.delete(workspace, "F12345678");
  }
  expect(calls).toEqual([...(Array<string>(4).fill(`Bearer ${slackTokens("a").bot}`)), ...(Array<string>(4).fill(`Bearer ${slackTokens("b").bot}`))]);
  for (const scope of [undefined, { ...A, teamId: B.teamId }]) await expect(delivery.delete(scope, "F12345678")).rejects.toThrow("This Slack workspace is not available.");
  expect(calls).toHaveLength(8); expect(legacy).not.toHaveBeenCalled();
});
