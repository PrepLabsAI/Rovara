// L4-EINT: the PRODUCTION path of the eval stand-ins, behind ONE operator switch. The broker answers the worker's `eval-plan` ask with a small DESCRIPTOR of what this project's evals reach (the free dry run's outside host
// list, kept per company and project, and the stand-in writer's sample set), and the worker plans a stand-in round from it plus the repository's own recordings and OpenAPI files, read from the BASE commit only.
//
// THE SWITCH (default OFF). `AGENTX_EVAL_STAND_INS` is read by the operator's install, on the broker (the descriptor is delivered only when it is exactly "1") and on the worker (the round is planned only when it is exactly "1").
// Anything else, or the variable absent, is today's behaviour byte for byte: no descriptor on the wire, no stand-in round, no seed, no stand-in version in a cache key.
//
// WHAT THE DESCRIPTOR CAN NAME. Host names that passed the dry run's strict shape; NEVER a host of the FIXED telemetry list (`evalTelemetryEntryOf`: those are answered `OK` by the stand-in itself and are not stood in).
// A repository cannot add to either list through this: the hosts are what the sandboxed eval was seen to look up, not what any file says.
import { z } from "zod";
import { EVAL_BLOCKED_HOST } from "./eval-run-diagnostic.js";
import { evalTelemetryEntryOf } from "./eval-telemetry-hosts.js";
import { StandInWriterSetSchema } from "./standin-writer.js";

/** The operator's switch: exactly "1" is on; anything else (or unset) is off. */
export const EVAL_STAND_INS_VARIABLE = "AGENTX_EVAL_STAND_INS";
export const evalStandInsOn = (environment: Readonly<Record<string, string | undefined>>): boolean => environment[EVAL_STAND_INS_VARIABLE] === "1";

export const EVAL_STAND_IN_DESCRIPTOR_HOSTS_MAX = 16;
const Port = z.number().int().min(1).max(65_535);
export const EvalStandInDescriptorSchema = z.object({
  version: z.literal(1),
  /** Outside names the free dry run saw the eval look up. Never a telemetry host. */
  hosts: z.array(z.object({ name: z.string().regex(EVAL_BLOCKED_HOST).refine((name) => evalTelemetryEntryOf(name) === undefined, "a telemetry host is answered by the stand-in itself"), port: Port.optional() }).strict()).max(EVAL_STAND_IN_DESCRIPTOR_HOSTS_MAX),
  /** The stand-in writer's stored set for the project (sample answers by operation id), when there is one. */
  writerSet: StandInWriterSetSchema.optional(),
}).strict();
export type EvalStandInDescriptor = z.infer<typeof EvalStandInDescriptorSchema>;
