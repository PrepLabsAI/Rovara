import { expect, it, vi } from "vitest";
import { createWorkspaceSlackClients } from "../../packages/slack-service/src/slack-workspace-clients.js";
import { createSlackServiceDelivery } from "../../packages/slack-service/src/main.js";
import { slackTokens } from "../../packages/testing/src/channel/slack-world.js";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const thread = { teamId: "T0AAAAAAA", channelId: "C0SHARED", threadTs: "1695500000.000001" };
it("keeps concurrent post/delete/name requests in their workspace with identical raw ids", async () => {
  const seen: Array<[string, boolean]> = [];
  const legacy = vi.fn(async () => slackTokens("legacy").bot);
  const clients = createSlackServiceDelivery({ legacyToken: legacy,
    workspaces: { requireCompany: async (team) => team === thread.teamId ? A : B,
      tokenForCompany: async (company) => slackTokens(company === A ? "a" : "b").bot },
    fetch: async (url, init) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      seen.push([(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).split("/").at(-1)!, auth === `Bearer ${slackTokens("a").bot}`]);
      await Promise.resolve();
      return new Response(JSON.stringify({ ok: true, ts: thread.threadTs, user: { name: auth === `Bearer ${slackTokens("a").bot}` ? "alpha" : "beta" } }));
    },
  });
  const other = { ...thread, teamId: "T0BBBBBBB" };
  await Promise.all([clients.post(thread, thread.threadTs, "a"), clients.delete(other, thread.threadTs)]);
  expect(await Promise.all([clients.userName(thread, "U0SHARED"), clients.userName(other, "U0SHARED")])).toEqual(["alpha", "beta"]);
  expect(seen.slice(0, 2)).toEqual([["chat.postMessage", true], ["chat.delete", false]]);
  expect(legacy).not.toHaveBeenCalled();
});
it("refuses missing bindings with fixed words and never reads the legacy token", async () => {
  const legacy = vi.fn(); const read = vi.fn();
  const clients = createWorkspaceSlackClients({ legacyToken: legacy, workspaces: { requireCompany: async () => { throw Error("private marker"); }, tokenForCompany: read } });
  await expect(clients.forThread(thread)).rejects.toThrow("This Slack workspace is not available.");
  expect(legacy).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
it("bounds the TOTAL workspace cache and preserves one legacy client", async () => {
  const legacyToken = async () => slackTokens("legacy").bot;
  const old = createWorkspaceSlackClients({ legacyToken });
  expect(await old.forThread(thread)).toBe(await old.forThread({ ...thread, teamId: "T0BBBBBBB" }));
  const scoped = createWorkspaceSlackClients({ legacyToken, workspaces: { requireCompany: async () => A, tokenForCompany: legacyToken } });
  const first = await scoped.forThread(thread);
  for (let i = 0; i < 128; i++) await scoped.forThread({ ...thread, teamId: `T${String(i).padStart(8, "0")}` });
  expect(await scoped.forThread(thread)).not.toBe(first);
});
