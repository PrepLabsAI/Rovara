// Playbook P3: the proof table of the task page (`proofTable` in the version 2 task view). The rows and the not-tested list are exactly what `buildProofTable` gives the pull request's Proof
// section, and the test-proof lines are the ones its Tests section lists, from the same inputs (`loadProofContext`). Two differences, both for the page: the strings are plain words (the table escapes `&` and `<` and puts a joiner after `@` for GitHub; the page shows text
// as text, so those are undone), and when the checks were recorded for code that is no longer the candidate, the table reads those earlier results instead of calling every requirement untested (the page labels
// it "earlier", the way it labels the recorded checks).
import { redactText, type ProofTableView, type WorkflowSnapshot } from "@agentx/contracts";
import { buildProofTable, testProofLinesOf } from "./proof-table.js";
import { earlierProofCheckResults, proofCheckResults, recordedCheckIdsOf, type ProofContext } from "./proof-section.js";

/**
 * The page's words for a string `buildProofTable` made inert for GitHub: its escapes undone (`&lt;` before `&amp;`, so `&amp;lt;` stays `&lt;`), its joiners dropped, anything secret-shaped redacted again, and
 * then cut to the contract's limit for that field (counted in code points, as the inert helpers count). The cut comes last: redacting a tail the first cut made (`-pabc` to `-p[REDACTED]`) can make a string longer
 * than the builder left it, and one string over its limit would make the whole session view unreadable for web readers.
 */
const plain = (text: string, max: number): string => {
  const points = Array.from(redactText(text.replaceAll("\u200D", "").replaceAll("&lt;", "<").replaceAll("&amp;", "&")));
  return points.length <= max ? points.join("") : `${points.slice(0, max - 1).join("")}…`;
};

/** The table for the task view, or undefined when there is no approved structured plan with claims. Reads nothing; a fault in the plan's shape gives undefined (the page then has no table). */
export function proofTableView(workflow: WorkflowSnapshot, proof: ProofContext | undefined): ProofTableView | undefined {
  const plan = proof?.plan;
  if (plan === undefined || !Array.isArray(plan.claims) || plan.claims.length === 0) return undefined;
  try {
    const earlier = earlierProofCheckResults(workflow);
    const table = buildProofTable({
      plan, checkResults: earlier.length > 0 ? earlier : proofCheckResults(workflow), scenarioRows: proof?.scenarioRows ?? [], testProof: proof?.testProof, candidateDigest: workflow.candidate?.digest, recordedCheckIds: recordedCheckIdsOf(workflow),
    });
    return {
      rows: table.rows.slice(0, 50).map((row) => ({
        claimId: row.claimId, requirement: plain(row.requirement, 300), result: row.result,
        evidence: row.evidence.slice(0, 100).map((item) => ({ kind: item.kind, label: plain(item.label, 120), state: item.state })),
      })),
      notTested: table.notTested.slice(0, 200).map((item) => ({ kind: item.kind, id: plain(item.id, 64), text: plain(item.text, 300), reason: plain(item.reason, 100) })),
      testProofLines: testProofLinesOf(proof?.testProof, workflow.candidate?.digest).slice(0, 4).map((line) => plain(line, 600)),
    };
  } catch {
    return undefined;
  }
}
