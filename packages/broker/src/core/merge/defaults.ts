// Port lane L7a: Code's defaults for the merge core's seams.
import { DEFAULT_CODE_SETTINGS, type CodeSettings } from "@agentx/contracts";
import type { CodeSettingsReader } from "./seams.js";

/**
 * A project's code settings in Code: self-approval ON. Code has one owner (decision 45.3: the Approvers seam returns the owner alone, self-approval allowed), so a rule that only another
 * person's approval counts would make every merge impossible. The repository's own branch protection still governs the host (the merge button there, and a merge by Rovara only with the
 * owner's proof). Squash, no reviewers, as in Cloud.
 */
export const CODE_LOCAL_SETTINGS: CodeSettings = { ...DEFAULT_CODE_SETTINGS, allowSelfApproval: true };

/** Settings that are the same for every project (a project's playbook file can override them in the lane that reads it). */
export function fixedCodeSettings(settings: CodeSettings = CODE_LOCAL_SETTINGS): CodeSettingsReader {
  return { read: async () => settings };
}
