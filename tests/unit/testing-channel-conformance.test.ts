// The channel contract suite (packages/testing/src/channel), run on the fake adapter and on the real Slack adapter over a fake network, and shown to fail on adapters broken on purpose. The Slack run is the proof: it is the shipped
// adapter (its web client, rendering, socket and parsing), and only the chat tool's network is fake.
import { describe, expect, it } from "vitest";
import type { ChannelAdapter, ChannelEvent, ChannelInboundSink } from "@agentx/contracts";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { channelChecks, fakeChannelWorld, slackChannelWorld, slackTokens, type ChannelWorld } from "../../packages/testing/src/channel/index.js";
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

class RepeatsEvents extends FakeChannelAdapter {
  override async deliver(event: ChannelEvent): Promise<void> { this.delivered.push(structuredClone(event)); }
}
class LosesTheThread extends FakeChannelAdapter {
  override async deliver(event: ChannelEvent): Promise<void> {
    await super.deliver(event);
    const last = this.delivered.at(-1);
    if (last !== undefined && last.type !== "direct") this.delivered[this.delivered.length - 1] = { ...last, conversation: { ...last.conversation, thread: "elsewhere" } };
  }
}
class ShowsPrivateNotesToAll extends FakeChannelAdapter {
  override async deliver(event: ChannelEvent): Promise<void> {
    await super.deliver(event.type === "progress" ? { ...event, data: { text: event.data.text } } : event);
  }
}
class NeverForgetsTheSink extends FakeChannelAdapter {
  override async start(sink: ChannelInboundSink): Promise<{ stop(): Promise<void> }> {
    this.sink = sink;
    return { stop: async () => undefined };
  }
}

describe("a broken fake channel adapter fails the check that guards its behaviour", () => {
  it("shows a repeated event twice", async () => {
    expect(await fails("drops a repeat of an event id: at least once is never twice", fakeChannelWorld({ adapter: new RepeatsEvents() }))).toBe(true);
  });
  it("shows an event outside the thread it names", async () => {
    expect(await fails("says what Rovara's events say, in the conversation they name: a message, progress, a question, a check report, a pull request, an error and a closing line", fakeChannelWorld({ adapter: new LosesTheThread() }))).toBe(true);
  });
  it("shows a note meant for one account to everybody", async () => {
    expect(await fails("shows a note meant for one account to that account alone", fakeChannelWorld({ adapter: new ShowsPrivateNotesToAll() }))).toBe(true);
  });
  it("keeps listening after it is stopped", async () => {
    expect(await fails("stops listening when it is stopped: the connection closes and nothing more reaches the sink", fakeChannelWorld({ adapter: new NeverForgetsTheSink() }))).toBe(true);
  });
});

describe("a broken Slack adapter fails the check that guards its behaviour", () => {
  const tokens = slackTokens();
  it("posts a conversation of another workspace into its own", async () => {
    const world = slackChannelWorld({ wrap: (real) => around(real, { deliver: (event) => real.deliver({ ...event, conversation: { ...(event as { conversation: object }).conversation, tenant: "T0AAAAAAA" } } as ChannelEvent) }) });
    expect(await fails("refuses a conversation of a workspace it is not installed in, and shows nothing there", world)).toBe(true);
  });
  it("takes a send that failed as sent", async () => {
    const world = slackChannelWorld({ wrap: (real) => around(real, { deliver: (event) => real.deliver(event).catch(() => undefined) }) });
    expect(await fails("does not take an event it failed to send as sent: the retry shows it once", world)).toBe(true);
  });
  it("puts its token in the error it throws", async () => {
    const world = slackChannelWorld({ wrap: (real) => around(real, { deliver: (event) => real.deliver(event).catch((error: Error) => { throw new Error(`${error.message} (token ${tokens.bot})`); }) }) });
    expect(await fails("says nothing a credential could be read from when a send fails: not in the error, not in the log, not in what people were shown", world)).toBe(true);
  });
  it("changes the revision of a decision on its way to the core", async () => {
    const world = slackChannelWorld({ wrap: (real) => around(real, { start: (sink) => real.start(({ message: (m) => sink.message(m), decision: (d) => sink.decision({ ...d, expectedRevision: d.expectedRevision + 1 }) })) }) });
    expect(await fails("hears a press of a card's button as a decision for exactly the request the card named, and decides nothing itself", world)).toBe(true);
  });
  it("drops the words of a request for changes", async () => {
    const world = slackChannelWorld({ wrap: (real) => around(real, { start: (sink) => real.start(({ message: (m) => sink.message(m), decision: (d) => sink.decision({ ...d, reason: "Pressed in chat." }) })) }) });
    expect(await fails("carries the person's own words as the reason of a request for changes", world)).toBe(true);
  });
  it("does not close its connection when stopped", async () => {
    const world = slackChannelWorld({ wrap: (real) => around(real, { start: async (sink) => { await real.start(sink); return { stop: async () => undefined }; } }) });
    expect(await fails("stops listening when it is stopped: the connection closes and nothing more reaches the sink", world)).toBe(true);
  });
  it("positive control: the same checks pass on the unbroken adapter, so each failure above comes from its break", async () => {
    for (const check of channelChecks) {
      const world = slackChannelWorld();
      if (check.needs !== undefined && !check.needs(world)) continue;
      await check.run(world);
    }
  });
});
