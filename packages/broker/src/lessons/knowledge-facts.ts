// Lead 4 L4-AK2: the one measured fact source there is today: the tests the base's last usable nightly baseline found flaky (`core/test-env/base-flaky.ts`). Code counted them; nobody wrote them. Each becomes one fact line
// that tells a Build or Review step not to chase a known flake. The only free text in a line is the test's name, cleaned, cut and on one line (a test name is repository text). No baseline or no flaky test: no facts.
import { createHash } from "node:crypto";
import { cleanLessonText, type KnowledgeFact, type OrgId } from "@agentx/contracts";
import type { KnowledgeFactsPort } from "./knowledge-brief.js";

const NAME_MAX = 120;
const FACTS_MAX = 5;

/** The fact lines for a list of flaky test names (a pure helper, for its tests). Sorted by name so the same set always reads the same. */
export function flakyFactsOf(names: readonly string[]): KnowledgeFact[] {
  return [...new Set(names.map((name) => cleanLessonText(name, NAME_MAX).replace(/\s+/gu, " ").trim()).filter((name) => name !== ""))].sort().slice(0, FACTS_MAX).map((name) => ({
    id: `flaky${createHash("sha256").update(name).digest("hex").slice(0, 10)}`,
    statement: `Known flaky on the base: ${name}. Do not chase it unless your change touches what it tests.`,
    paths: [],
  }));
}

/** A facts port over the base's flaky list. `baseFlaky` is `baseFlakyTests` of the host's test-environment deps; it answers undefined when the base's flaky set is not known. Never throws. */
export function flakyFactsPort(baseFlaky: (task: { orgId: OrgId; project: string }) => Promise<readonly string[] | undefined>): KnowledgeFactsPort {
  return async (input) => {
    try {
      const names = await baseFlaky({ orgId: input.companyId, project: input.project });
      return names === undefined ? [] : flakyFactsOf(names);
    } catch {
      return [];
    }
  };
}
