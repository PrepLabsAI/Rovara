// TEST-RESULT-HONESTY: the "not tested" line for a task whose project HAS an approved test environment that was not applied to it, in the words the pin recorded (usable.ts `UNUSED_WORDS`: "Test services not available here: ..."),
// so the task's evidence says which one, instead of the generic "No approved test environment". A task with no pin, or a pin that was applied, gets nothing: the generic line stands, or there is no gap to name.
import type { EvidenceNotTested } from "@agentx/contracts";
import type { StoreOnly } from "./deps.js";
import { UNUSED_WORDS, readTestEnvPin } from "./usable.js";

export async function unusedEnvironmentNote(deps: StoreOnly, orgId: string, project: string, taskId: string): Promise<EvidenceNotTested | undefined> {
  const pin = await readTestEnvPin(deps, orgId, project, taskId);
  return pin?.unused === undefined ? undefined : { kind: "environment", id: "test_environment", text: `${UNUSED_WORDS[pin.unused]}; the project's own test setup was used`, reason: "not applied" };
}
