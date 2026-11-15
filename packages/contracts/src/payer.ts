// The payer rules, shared by task starts and the model gateway's task description.
import { z } from "zod";
import { PayerSchema, WorkOriginSchema, type Payer, type WorkOrigin } from "./agent-run-node.js";
import { AgentIdSchema, type AgentId } from "./agent.js";
import { AGENTX_NAME_PATTERN } from "./names.js";
import { agentXError } from "./errors.js";

export const PAYER_UNRESOLVED = "could not work out who pays for this task";
export interface NamedPerson { developerId: string }
export interface ResolvePayerInput {
  origin: WorkOrigin;
  project: string;
  /** A missing project AI payer setting means false. */
  projectPays?: boolean;
  agentId?: AgentId;
  chainId?: string;
  chainPayer?: Payer;
  startedBy?: NamedPerson;
  assignedBy?: { developerId?: string; bot: boolean };
  approvedBy?: NamedPerson;
  acceptedBy?: NamedPerson;
}
const person = z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const inputSchema = z.object({
  origin: WorkOriginSchema, project: z.string().regex(AGENTX_NAME_PATTERN), projectPays: z.boolean().optional(),
  agentId: AgentIdSchema.optional(), chainId: z.string().regex(/^chn_[0-9a-z]{20}$/u).optional(), chainPayer: PayerSchema.optional(),
  startedBy: person.optional(), assignedBy: z.object({ developerId: person.shape.developerId.optional(), bot: z.boolean() }).strict().optional(),
  approvedBy: person.optional(), acceptedBy: person.optional(),
}).strict();
const member = (p: NamedPerson): Payer => ({ kind: "member", developerId: p.developerId });
const needs = () => agentXError("CONFIG_INVALID", PAYER_UNRESOLVED);

/** Existing precedence: own project jobs; trigger chain/agent; chain payer; project setting; assigner/approver; accepter; starter. */
export function resolvePayer(value: ResolvePayerInput): Payer {
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) throw needs();
  const input = parsed.data;
  switch (input.origin) {
    case "test_run":
    case "nightly":
    case "automatic": return { kind: "project", project: input.project };
    case "event":
    case "schedule":
      if (input.chainId !== undefined) return { kind: "chain", chainId: input.chainId };
      if (input.agentId === undefined) throw needs();
      return { kind: "agent", agentId: input.agentId };
    case "chain":
      if (input.chainPayer === undefined) throw needs();
      return input.chainPayer;
    default: break;
  }
  if (input.projectPays) return { kind: "project", project: input.project };
  if (input.origin === "linear") {
    const assigner = input.assignedBy;
    if (assigner !== undefined && !assigner.bot && assigner.developerId !== undefined) return { kind: "member", developerId: assigner.developerId };
    return input.approvedBy === undefined ? { kind: "project", project: input.project } : member(input.approvedBy);
  }
  if (input.origin === "offer") {
    if (input.acceptedBy === undefined) throw needs();
    return member(input.acceptedBy);
  }
  if (input.startedBy === undefined) throw needs();
  return member(input.startedBy);
}
