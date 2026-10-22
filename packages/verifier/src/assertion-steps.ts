import type { EngineFixtureContext } from "e2e/engine";

/**
 * Approved assertions as upstream report steps, shared by every host that has an engine to contribute them (web and API).
 *
 * An engine can contribute a fixture whose declared operation the runner records as an `assertion` step. The case adapter opens one
 * such step per approved assertion before it does anything else: the runner numbers steps in the order they start, so the report
 * names a failed approved assertion by the step at its own index, which is where the collector looks.
 */
export const ASSERTION_FIXTURE = "agentxAssertions" as const;
/**
 * `confirm` is the seal step of Task 4.6a (CAPTURE46): one more passed `assertion` step that a web case records after its AI navigation step, when every approved assertion held. The
 * runner writes a step's recording only when a verifying step that started after it passed, and the approved assertions above start first, so without this the recording of an
 * agent step is never kept.
 */
export type AssertionSteps = Readonly<{ step(index: number, body: () => Promise<void>): Promise<void>; confirm(): Promise<void> }>;
export const ASSERTION_SEAL_LABEL = "approved assertions held" as const;

/** The factory an engine lists under `fixtures`; a fresh surface per attempt, because the runner wraps the declared method in place. */
export const assertionStepFixture = (context: EngineFixtureContext) => context.fixture<{ step(index: number, body: () => Promise<void>): Promise<void>; confirm(): Promise<void> }>(ASSERTION_FIXTURE,
  { async step(_index, body) { await body(); }, async confirm() { /* the step the runner records is the whole effect */ } },
  { step: { kind: "assertion", label: (index: number) => `approved assertion ${index}`, timeout: false },
    confirm: { kind: "assertion", label: () => ASSERTION_SEAL_LABEL, timeout: false } });

/** The fixture a case receives from its engine, or a refusal naming what is missing. */
export function assertionStepsOf(fixtures: unknown): AssertionSteps {
  const row = (fixtures && typeof fixtures === "object" ? (fixtures as Record<string, unknown>)[ASSERTION_FIXTURE] : undefined) as Partial<AssertionSteps> | undefined;
  if (!row || typeof row.step !== "function" || typeof row.confirm !== "function") throw new Error("installed engine did not provide its assertion-step fixture");
  return row as AssertionSteps;
}

/** Thrown inside the assertion step of the first approved assertion that did not hold, so exactly that step fails. */
class ApprovedAssertionMismatch extends Error {
  constructor(readonly assertionIndex: number) { super(`approved assertion ${assertionIndex} did not hold`); }
}
const isMismatch = (error: unknown): boolean => error instanceof ApprovedAssertionMismatch
  || (error instanceof Error && error.cause instanceof ApprovedAssertionMismatch);

/** `agentStopped` is set when an agent step did not conclude, so no assertion was observed (Task 4.4a); the case then ends in an error all the same. */
export type CaseOutcome = Readonly<{ failedIndex: number; unavailableIndex: number; agentStopped?: Readonly<{ stopCode: string | null }> | null }>;
export type ChainResult = Readonly<{ outcome: CaseOutcome | null; error: unknown }>;

/**
 * Runs `work` inside one nested `assertion` step per approved assertion. Step k of the report is approved assertion k only when
 * these are the first steps of the attempt, which is why nothing else may run before this. Only the step of an assertion that did
 * not hold fails. Any other failure (navigation, a crashed app, a missing element) is carried out of the chain as an error and
 * thrown after every step has closed, so no assertion step is ever blamed for it.
 */
export async function runInsideAssertionSteps(assertions: AssertionSteps, count: number, work: () => Promise<CaseOutcome>): Promise<ChainResult> {
  const open = async (level: number): Promise<ChainResult> => {
    if (level === count) {
      try { return { outcome: await work(), error: undefined }; }
      catch (error) { return { outcome: null, error }; }
    }
    let inner: ChainResult = { outcome: null, error: undefined };
    try {
      await assertions.step(level, async () => {
        inner = await open(level + 1);
        if (inner.outcome?.failedIndex === level) throw new ApprovedAssertionMismatch(level);
      });
    } catch (error) { if (!isMismatch(error)) throw error; }
    return inner;
  };
  return open(0);
}
