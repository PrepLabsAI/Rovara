// The title of the spec pull request, and the folders a spec never goes into. (The spec is published by the broker itself: see publish.ts.)
import { META_KNOWLEDGE_DEFAULTS } from "@agentx/contracts";

/**
 * The project's own knowledge folders (steering, skills, runbooks, key docs), which a spec is never written into: checked when the spec is laid out and again when it is published. The project's definition holds no
 * knowledge paths of its own yet (the meta config's `knowledge` section is carried, not applied), so these are the places the meta checkout reads them from; the config's own apply refuses a spec folder inside the
 * ones that file names.
 */
export function projectForbiddenFolders(): string[] {
  return [...META_KNOWLEDGE_DEFAULTS.steering, ...META_KNOWLEDGE_DEFAULTS.skills, ...META_KNOWLEDGE_DEFAULTS.runbooks, ...META_KNOWLEDGE_DEFAULTS.keyDocs];
}

/** The title of the spec pull request: the task's title as one inert line. */
export function specPullRequestTitle(taskTitle: string): string {
  const plain = taskTitle.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").replace(/[@<>`]/gu, "").trim().slice(0, 200);
  return `Rovara spec: ${plain === "" ? "task" : plain}`.slice(0, 256);
}
