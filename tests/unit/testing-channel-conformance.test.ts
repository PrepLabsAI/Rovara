// The channel contract suite (packages/testing/src/channel), run on the fake adapter and on the real Slack adapter over a fake network, and shown to fail on adapters broken on purpose. The Slack run is the proof: it is the shipped
// adapter (its web client, rendering, socket and parsing), and only the chat tool's network is fake.
import { describe, expect, it } from "vitest";
import type { ChannelAdapter, ChannelEvent } from "@agentx/contracts";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { channelChecks, fakeChannelWorld, slackChannelWorld, type ChannelWorld } from "../../packages/testing/src/channel/index.js";
import { runContract } from "../../packages/testing/src/ports/plugin-contract-kit.js";

runContract("FakeChannelAdapter passes the channel contract", channelChecks, () => fakeChannelWorld());
runContract("the Slack channel adapter passes the channel contract", channelChecks, () => slackChannelWorld());

async function fails(name: string, world: ChannelWorld): Promise<boolean> {
  const check = channelChecks.find((entry) => entry.name === name);
  if (check === undefined) throw new Error(`no check named ${name}`);
  expect(check.needs === undefined || check.needs(world), "the world has what the check needs").toBe(true);
  try {
    await check.run(world);
  } catch {
    return true;
  }
  return false;
}

/** An adapter that is another one with some of its behaviour replaced. */
function around(inner: ChannelAdapter, replace: Partial<Pick<ChannelAdapter, "deliver" | "start">>): ChannelAdapter {
  return {
    capabilities: inner.capabilities, projects: inner.projects, stepUp: inner.stepUp, ...(inner.noThread === undefined ? {} : { noThread: inner.noThread }),
    deliver: replace.deliver ?? ((event) => inner.deliver(event)),
    ...(inner.start === undefined && replace.start === undefined ? {} : { start: replace.start ?? ((sink) => inner.start!(sink)) }),
  };
}

class LosesTheThread extends FakeChannelAdapter {
  override async deliver(event: ChannelEvent): Promise<void> {
    await super.deliver(event);
    const last = this.delivered.at(-1);
    if (last !== undefined && last.type !== "direct") this.delivered[this.delivered.length - 1] = { ...last, conversation: { ...last.conversation, thread: "elsewhere" } };
  }
}

describe("a broken fake channel adapter fails the check that guards its behaviour", () => {
  it("shows an event outside the thread it names", async () => {
    expect(await fails("says what Rovara's events say, in the conversation they name: a message, progress, a question, a check report, a pull request, an error and a closing line", fakeChannelWorld({ adapter: new LosesTheThread() }))).toBe(true);
  });
});

describe("a broken Slack adapter fails the check that guards its behaviour", () => {
  it("posts a conversation of another workspace into its own", async () => {
    const world = slackChannelWorld({ wrap: (real) => around(real, { deliver: (event) => real.deliver({ ...event, conversation: { ...(event as { conversation: object }).conversation, tenant: "T0AAAAAAA" } } as ChannelEvent) }) });
    expect(await fails("refuses a conversation of a workspace it is not installed in, and shows nothing there", world)).toBe(true);
  });
  it("positive control: the same checks pass on the unbroken adapter, so each failure above comes from its break", async () => {
    for (const check of channelChecks) {
      const world = slackChannelWorld();
      if (check.needs !== undefined && !check.needs(world)) continue;
      await check.run(world);
    }
  });
});
