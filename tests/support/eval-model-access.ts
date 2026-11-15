// A scripted model-access port for the eval host binding tests: no network, no timers it does not own.
import type { EvalSpendGrant, ModelEgress, ModelEgressClass, ModelEgressEvent, ModelEgressFrame, ModelEgressScope } from "@agentx/contracts";
import type { EvalModelAccess, EvalModelHold } from "../../packages/worker/src/verification/eval-model-access.js";

export const frame = (text = "question"): ModelEgressFrame => ({ row: "gemini", method: "POST", path: "/v1beta/models/m:generateContent", query: "", headers: [["content-type", "application/json"]], body: new TextEncoder().encode(text) });
const enc = (text: string) => new TextEncoder().encode(text);
export const settle = (over: Partial<Extract<ModelEgressEvent, { kind: "settle" }>> = {}): ModelEgressEvent => ({ kind: "settle", status: 200, class: "ok", costMicros: 10, estimated: false, ...over });
export const answer = (over: Partial<Extract<ModelEgressEvent, { kind: "settle" }>> = {}, text = "{\"ok\":true}"): ModelEgressEvent[] => [{ kind: "head", status: over.status ?? 200, headers: [["content-type", "application/json"]] }, { kind: "chunk", bytes: enc(text) }, settle(over)];
export const classAnswer = (cls: ModelEgressClass, status: number, costMicros = 0): ModelEgressEvent[] => answer({ class: cls, status, costMicros }, "{\"error\":\"x\"}");

export type Script = (frame: ModelEgressFrame, index: number, signal: AbortSignal | undefined) => AsyncIterable<ModelEgressEvent> | readonly ModelEgressEvent[] | Promise<never>;
export interface ScriptedAccess {
  readonly access: EvalModelAccess;
  readonly holds: Array<{ grant: EvalSpendGrant; calls: number; costMicros: number }>;
  readonly forwarded: ModelEgressFrame[];
  readonly scopes: ModelEgressScope[];
  readonly released: Array<{ calls: number; costMicros: number; unknown: boolean }>;
  /** Refuse the next hold (returns undefined) or throw from it. */
  refuse(mode: "undefined" | "throw"): void;
  failRelease(): void;
  inFlight(): number;
  /** The most calls the egress had open at once. */
  peak(): number;
}
export function scriptedAccess(script: Script = () => answer()): ScriptedAccess {
  const holds: ScriptedAccess["holds"] = []; const forwarded: ModelEgressFrame[] = []; const scopes: ModelEgressScope[] = []; const released: ScriptedAccess["released"] = [];
  let refuse: "undefined" | "throw" | undefined; let releaseFails = false; let inFlight = 0; let index = 0; let peak = 0;
  const scope = Object.freeze({ opaque: "scope" }) as unknown as ModelEgressScope;
  const egress: ModelEgress = {
    capabilities: { schemes: [] },
    async *forward(s, f, options) {
      scopes.push(s); forwarded.push(f); inFlight++; peak = Math.max(peak, inFlight);
      try {
        const out = await script(f, index++, options?.signal);
        if (Symbol.asyncIterator in out) yield* out;
        else yield* out;
      } finally { inFlight--; }
    },
  };
  const access: EvalModelAccess = {
    async hold(input) {
      holds.push({ grant: input.grant, calls: input.calls, costMicros: input.costMicros });
      if (refuse === "throw") throw new Error("gateway-secret-detail");
      if (refuse === "undefined") return undefined;
      const hold: EvalModelHold = { egress, scope, release: async spent => { released.push({ ...spent }); if (releaseFails) throw new Error("release-secret-detail"); } };
      return hold;
    },
  };
  return { access, holds, forwarded, scopes, released, refuse: m => { refuse = m; }, failRelease: () => { releaseFails = true; }, inFlight: () => inFlight, peak: () => peak };
}
