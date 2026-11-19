// L4-EINT: the broker's side of the stand-in production path. Reads, for the run's OWN company and project only, what the project's evals reach: the free dry run's outside hosts (EVAL_DEPENDENCY_LIST, kept per company+project)
// and the stand-in writer's stored sample set. The answer rides the worker's existing `eval-plan` ask as one optional field (`standIns`); nothing new is exposed and no route is added.
//
// OFF BY DEFAULT: `createEvalStandInDescriptorSource` returns undefined unless the operator's switch `AGENTX_EVAL_STAND_INS` is exactly "1", and then `createEvalPlanSources` adds nothing to the answer (today's bytes).
// Fail closed: a list or set that cannot be read gives no descriptor (the eval runs as it does without stand-ins); a host of the FIXED telemetry list never appears in it.
import { evalStandInsOn, evalTelemetryEntryOf, EvalStandInDescriptorSchema, type DocumentStore, type EvalStandInDescriptor, type OrgId } from "@agentx/contracts";
import type { FixtureObjectPort } from "../test-env/fixture-store.js";
import { createStandInDataStore } from "../test-env/standin-data-store.js";
import { NO_PROD_DENY } from "../proof/evidence-guard.js";
import { readEvalDependencyList } from "./eval-dependency-list.js";

export interface EvalStandInDescriptorDeps {
  readonly store: DocumentStore;
  readonly companyId: OrgId;
  /** The install's object storage for the writer's set (absent: no writer set is delivered). */
  readonly objects?: FixtureObjectPort | undefined;
  readonly now?: () => number;
}

/** The descriptor of one project, or undefined (nothing known, nothing readable, or nothing a stand-in would serve). Only this company's rows are read. */
export async function readEvalStandInDescriptor(deps: EvalStandInDescriptorDeps, project: string): Promise<EvalStandInDescriptor | undefined> {
  try {
    const found = await readEvalDependencyList({ store: deps.store, companyId: deps.companyId }, project);
    const hosts = (found?.list.hosts ?? []).filter((host) => evalTelemetryEntryOf(host.name) === undefined).map((host) => ({ name: host.name, ...(host.port === undefined ? {} : { port: host.port }) }));
    let writerSet: EvalStandInDescriptor["writerSet"];
    if (deps.objects !== undefined) {
      try {
        const current = await createStandInDataStore({ objects: deps.objects, documents: deps.store, denyFor: async () => NO_PROD_DENY, ...(deps.now === undefined ? {} : { now: () => new Date(deps.now!()) }) }).current(deps.companyId, project);
        if (current.ok) writerSet = current.set;
      } catch { writerSet = undefined; }
    }
    if (hosts.length === 0 && writerSet === undefined) return undefined;
    const parsed = EvalStandInDescriptorSchema.safeParse({ version: 1, hosts, ...(writerSet === undefined ? {} : { writerSet }) });
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

/** The source `createEvalPlanSources` takes, or undefined when the operator's switch is not "1". */
export function createEvalStandInDescriptorSource(deps: EvalStandInDescriptorDeps, environment: Readonly<Record<string, string | undefined>>): ((scope: { readonly companyId: string; readonly project: string }) => Promise<unknown>) | undefined {
  if (!evalStandInsOn(environment)) return undefined;
  return async (scope) => (scope.companyId === deps.companyId ? await readEvalStandInDescriptor(deps, scope.project) : undefined);
}
