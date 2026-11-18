// L4-SR1: the gateway's upkeep cap read, as a test double (contracts/upkeep.ts `UpkeepCapReadSchema`). Every variant a real gateway (or a broken one) could answer, for the nightly wiki refresh's cap gate.
import { IMPLICIT_COMPANY_ID, upkeepMonthOf } from "@agentx/contracts";
import type { UpkeepCapReader } from "../../packages/broker/src/core/upkeep/cap.js";

export type CapKind = "enforced" | "none" | "throws" | "stale" | "other_project" | "not_enforced" | "no_budget" | "used_up" | "garbage" | "extra_field" | "other_company";

/** The gateway's answer for a project at a time. */
export function capAnswer(project: string, nowMs: number, over: Record<string, unknown> = {}, company: string = IMPLICIT_COMPANY_ID): Record<string, unknown> {
  return { version: 1, company, project, month: upkeepMonthOf(nowMs), enforced: true, limitMicros: 25_000_000, spentMicros: 1_000_000, ...over };
}

/** A reader of the given kind (`kind` can be changed between nights). `none` is no reader at all (returned undefined), the others answer or fail as named. `calls` lists the projects asked about. */
export function capReader(initial: CapKind, now: () => number, company: string = IMPLICIT_COMPANY_ID): (UpkeepCapReader & { calls: string[]; kind: CapKind }) | undefined {
  if (initial === "none") return undefined;
  const calls: string[] = [];
  return {
    calls, kind: initial,
    async read(project) {
      calls.push(project);
      switch (this.kind) {
        case "enforced": return capAnswer(project, now(), {}, company);
        case "throws": throw new Error("gateway down");
        case "stale": return capAnswer(project, now() - 40 * 86_400_000);
        case "other_company": return capAnswer(project, now(), {}, "org_zzzzzzzzzzzzzzzzzzzz");
        case "other_project": return capAnswer("someone-else", now());
        case "not_enforced": return capAnswer(project, now(), { enforced: false }, company);
        case "no_budget": return capAnswer(project, now(), { limitMicros: 0, spentMicros: 0 }, company);
        case "used_up": return capAnswer(project, now(), { limitMicros: 25_000_000, spentMicros: 25_000_000 }, company);
        case "garbage": return "enforced";
        case "extra_field": return capAnswer(project, now(), { note: "x" }, company);
      }
    },
  };
}
