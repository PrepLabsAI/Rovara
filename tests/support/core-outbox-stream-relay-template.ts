// CORE-RUN-STOP-RELAY (G1): the control plane gains exactly one change here, the packed setting `rl` ("on": the core's outbox stream relay is deployed, so the hosted admission declares
// `enforcesCost`) on BOTH the broker and the dispatcher (infra/lib/core-engine.ts). `withoutCoreOutboxStreamRelay` checks it is exactly that (one `rl=on` piece in each function's AGENTX_SETTINGS,
// nothing else) and takes it out, so the pins and snapshots recorded before the lane still hold (Rule D: a re-pin is only for exactly this change). tests/contract/core-engine-infrastructure.test.ts
// ("the outbox stream relay setting") holds the setting together with the relay pieces it declares.
import { expect } from "vitest";
import { CORE_OUTBOX_STREAM_RELAY_ON } from "@agentx/contracts";
import { packedPiecesOf, removePackedPieces } from "./broker-environment-template.js";

type Resource = { Type: string; Properties: Record<string, unknown> };

/** Takes the `rl` piece out of the broker's and the dispatcher's packed settings (in place), asserting each is exactly the literal `on`. Returns `template`. */
export function withoutCoreOutboxStreamRelay<T>(template: T): T {
  const resources = (template as unknown as { Resources: Record<string, Resource> }).Resources;
  const functions = Object.entries(resources).filter(([id, resource]) => /^(Broker|Dispatcher)[0-9A-F]{8}$/u.test(id) && resource.Type === "AWS::Lambda::Function");
  expect(functions.map(([id]) => id.replace(/[0-9A-F]{8}$/u, "")).sort()).toEqual(["Broker", "Dispatcher"]);
  for (const [id, fn] of functions) {
    const variables = (fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(packedPiecesOf(variables.AGENTX_SETTINGS).get("rl"), id).toBe(CORE_OUTBOX_STREAM_RELAY_ON);
    removePackedPieces(variables, "AGENTX_SETTINGS", ["rl"]);
  }
  return template;
}
