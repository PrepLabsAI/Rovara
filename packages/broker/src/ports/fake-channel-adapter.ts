// Port lane W0: a fake in-process channel adapter for the `channel` point (Pratik's spec 062 types). It records what Rovara sends
// and lets a test play a person speaking.
import type { ChannelAdapter, ChannelCapabilities, ChannelEvent, ChannelInboundSink, StepUpKind } from "@agentx/contracts";

export const FAKE_CHANNEL_CAPABILITIES: ChannelCapabilities = { threads: true, buttons: 3, edits: false, maxTextLength: 4_000, proactive: true };

export class FakeChannelAdapter implements ChannelAdapter {
  readonly capabilities: ChannelCapabilities;
  readonly projects: readonly string[] = ["web"];
  readonly stepUp: readonly StepUpKind[] = ["plan_approval", "admin"];
  readonly delivered: ChannelEvent[] = [];
  sink: ChannelInboundSink | undefined;
  stopped = false;

  constructor(capabilities: ChannelCapabilities = FAKE_CHANNEL_CAPABILITIES) {
    this.capabilities = capabilities;
  }

  async deliver(event: ChannelEvent): Promise<void> {
    // At least once: a repeat of an event id is dropped, as an adapter must.
    if (!this.delivered.some((seen) => seen.id === event.id)) this.delivered.push(structuredClone(event));
  }

  async start(sink: ChannelInboundSink): Promise<{ stop(): Promise<void> }> {
    this.sink = sink;
    this.stopped = false;
    return {
      stop: async () => {
        this.stopped = true;
        this.sink = undefined;
      },
    };
  }
}
