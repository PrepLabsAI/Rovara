// TE-C6 (9d's decision on the VERIFY block): the seam that tells `recordBuilt` which failed checks of a run may count as passed because EVERY test that failed in them passed on the worker's one rerun.
// Behind `ROVARA_FLAKY_RERUN` (off unless exactly "1", read at each call). Everything here is fail closed: a switch that is off, a missing, oversized, unreadable or unparseable file, a file under another operation's
// prefix, ids the data guard would drop, or a check the broker's own entries do not show as a regression that failed, excuses nothing and the check stays FAILED exactly as before.
// The worker's file only NAMES checks and tests; the broker's own check entries decide what may be excused (`flakyOnlyChecks`), and the base's flaky set (`baseFlakyTests`) decides whether a test is flaky on the base too.
import { scanText } from "@agentx/verifier";
import { FLAKY_RERUN_ARTIFACT, FLAKY_RERUN_FILE_MAX_BYTES, FlakyRerunFileSchema, flakyOnlyChecks, type ObjectStorage } from "@agentx/contracts";
import { NO_PROD_DENY, evidenceFindings } from "../../core/proof/evidence-guard.js";
import type { TestEnvDeps } from "../../core/test-env/deps.js";
import { baseFlakyTests } from "../../core/test-env/base-flaky.js";
import { flakyRerunEnabled } from "../../core/test-env/switch.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { operationArtifactActions } from "./evidence.js";

export function createLocalFlakyChecks(options: { flow: Pick<TaskFlowDeps, "store" | "companyId">; blobs: ObjectStorage; testEnv: TestEnvDeps; env: NodeJS.ProcessEnv }): NonNullable<TaskFlowDeps["flakyChecks"]> {
  return async (input) => {
    try {
      if (!flakyRerunEnabled(options.env)) return undefined;
      const { task, operation } = input;
      const actions = operationArtifactActions({ store: options.flow.store, blobs: options.blobs }, task, operation);
      const prefix = `private/${task.ownerKey}/${task.workspaceId}/${operation.id}/`;
      const artifact = (await actions.artifacts(task.workspaceId, operation.id)).find((entry) => entry.name === FLAKY_RERUN_ARTIFACT);
      if (artifact === undefined || !artifact.objectKey.startsWith(prefix)) return undefined;
      const text = await actions.readArtifact(artifact.objectKey, FLAKY_RERUN_FILE_MAX_BYTES + 1);
      if (text === "" || Buffer.byteLength(text, "utf8") > FLAKY_RERUN_FILE_MAX_BYTES) return undefined;
      const parsed = FlakyRerunFileSchema.safeParse(JSON.parse(text) as unknown);
      if (!parsed.success) return undefined;
      // The ids are a repository's own text and will be kept on the workflow: the data guard looks at them as it does at every test name in the evidence, and a check whose ids it would drop is not excused.
      const clean = { ...parsed.data, checks: parsed.data.checks.filter((check) => evidenceFindings(check.flaky, NO_PROD_DENY, scanText).length === 0) };
      const excused = flakyOnlyChecks(clean, input.checks);
      if (excused.size === 0) return undefined;
      return { byCheck: excused, baseFlaky: await baseFlakyTests(options.testEnv, { orgId: options.flow.companyId, project: task.project }) };
    } catch {
      return undefined;
    }
  };
}
