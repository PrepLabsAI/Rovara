// What the task page's reads (RD-2.0) share: how a CLIENT reads an answer of Code's. Every read is tolerant (rule 8, F3 plan): every member is optional, an unknown member passes through, a value a newer Code may widen is a plain string
// (not an enum), and nothing is transformed (so each schema has a JSON Schema and joins the contract digest). A client that needs a member checks it is there; a missing one is never a parse failure.
// "Optional" here is `.nullish()`: a member served as null (a lane's "none") reads as absent instead of failing the whole answer, as a missing one does. A member of the wrong type, or a list entry that is not an object, still fails: write the
// producer to the shape.
// This package imports nothing of Code's, so the shapes below are written out here; the tests prove each served answer reads with them.
import { z } from "zod";

/** An object a client reads: unknown members pass through. */
export const loose = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

/** A pointer to something a person can open (a step, a file, a command, a screenshot): what it is, which one, and the address when Code serves one. */
export const LinkWireSchema = loose({ kind: z.string().nullish(), id: z.string().nullish(), href: z.string().nullish(), label: z.string().nullish() });

/** The `{ commit, at }` a result is for: the code it ran on and when. */
export const RanOnWireSchema = loose({ commit: z.string().nullish(), at: z.string().nullish() });

/** The plan's check as the plan document and the checks read name it. `command` is Code's own shape and is not read by a client. */
export const CheckWireSchema = loose({ id: z.string().nullish(), label: z.string().nullish(), kind: z.string().nullish(), command: z.unknown().nullish() });

const claimLeaf = loose({ id: z.string().nullish(), text: z.string().nullish(), evidence: z.array(z.unknown()).nullish() });
const claimMid = claimLeaf.extend({ children: z.array(claimLeaf).nullish() });
/** A plan claim, nested at most three deep (`1`, `1.1`, `1.1.1`). `evidence` entries are told apart by `kind` (code, sketch, flow, schema, stateMachine, quote); a client reads the kinds it knows. */
export const ClaimWireSchema = claimLeaf.extend({ children: z.array(claimMid).nullish() });

/** One decision of the plan: a question, two to four options, and Rovara's pick. */
export const PlanDecisionWireSchema = loose({
  id: z.string().nullish(), claimId: z.string().nullish(), question: z.string().nullish(),
  options: z.array(loose({ id: z.string().nullish(), label: z.string().nullish(), consequence: z.string().nullish() })).nullish(),
  recommended: z.string().nullish(),
});

/** The plan document, whole, as `GET .../plan` and the spec read serve it. Model text: a client shows it as text. */
export const PlanDocumentWireSchema = loose({
  schemaVersion: z.number().nullish(),
  title: z.string().nullish(),
  why: z.array(loose({ text: z.string().nullish(), author: z.string().nullish() })).nullish(),
  claims: z.array(ClaimWireSchema).nullish(),
  notChanging: z.array(z.string()).nullish(),
  risks: z.array(z.string()).nullish(),
  decisions: z.array(PlanDecisionWireSchema).nullish(),
  workBreakdown: z.unknown().nullish(),
  checks: loose({
    proposed: z.array(CheckWireSchema).nullish(), noneReason: z.string().nullish(), proposalNote: z.string().nullish(),
    proves: z.record(z.string(), z.array(z.string())).nullish(), alsoRun: z.array(CheckWireSchema).nullish(), expectOnBase: z.record(z.string(), z.string()).nullish(),
  }).nullish(),
  e2e: z.unknown().nullish(),
  noChangeNeeded: z.unknown().nullish(),
  scenarioProves: z.record(z.string(), z.array(z.string())).nullish(),
  setupChanges: z.unknown().nullish(),
});
