// A merged change to the playbook file changes what every later task is told, and design review's cost and approvers, so a pull request that touches it is graded high, in both places that grade paths.
import { describe, expect, it } from "vitest";
import { createCandidateManifest, type VerificationReport } from "@agentx/contracts";
import { isSensitivePath as planSensitive } from "../../packages/broker/src/core/decisions/sensitive-paths.js";
import { assessRisk, isSensitivePath as proofSensitive, type RiskFile } from "../../packages/broker/src/core/proof/risk.js";

const digest = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]).digest;
const clean: VerificationReport = { reviewOnly: false, passed: [{ label: "Unit tests" }], failed: [], notChecked: [], testsAdded: [] };
const file = (path: string): RiskFile => ({ repository: "payments", path, added: 3, removed: 1 });
const level = (path: string) => assessRisk({ changedFiles: [file(path)], changedFilesComplete: true, report: clean, acceptedFindings: [], securityFindings: 0, candidateDigest: digest }).level;

describe("the playbook and the project config are sensitive paths", () => {
  it.each([".rovara/playbook.yaml", ".rovara/playbook.yml", "services/api/.rovara/playbook.yaml", ".ROVARA/Playbook.YAML", "./.rovara/project.yaml", ".rovara/project.json"])("%s is high in both gradings", (path) => {
    expect(planSensitive(path), path).toBe(true);
    expect(proofSensitive(path), path).toBe(true);
    expect(level(path), path).toBe("high");
  });

  it.each(["src/playbook.yaml", "docs/rovara/playbook.yaml.md", ".rovara/lessons.md", ".rovara/loop.yaml", "playbook.yaml"])("%s is not made sensitive by the playbook rule", (path) => {
    expect(planSensitive(path), path).toBe(false);
    expect(proofSensitive(path), path).toBe(false);
  });
});
