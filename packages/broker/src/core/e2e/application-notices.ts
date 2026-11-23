// The retired notifier's safe, content-addressed projection, on core's object port.
import type { ObjectStorage } from "@agentx/contracts";
import type { ApplicationTask } from "./application-seams.js";
import { loadStoredWorkflowDisplay } from "./artifacts.js";
import { renderE2ENotifierSlackBlocks } from "../../e2e-presentation.js";

export async function applicationE2ENotice(objects: ObjectStorage, task: ApplicationTask, taskPageUrl?: string): Promise<unknown[] | undefined> {
  const captured = await loadStoredWorkflowDisplay({ objects }, task);
  return captured === undefined ? undefined : renderE2ENotifierSlackBlocks(captured.view,
    { candidateDigest: captured.candidateDigest, roundId: captured.roundId, capturedAt: captured.capturedAt,
      ...(captured.scenarioResults === undefined ? {} : { scenarioResults: captured.scenarioResults }) }, taskPageUrl);
}

/** Existing channel events carry prose; the rendered projection supplies its bounded summary without a channel contract change. */
export function applicationNoticeText(blocks: readonly unknown[] | undefined): string {
  return (blocks ?? []).flatMap((block) => {
    if (typeof block !== "object" || block === null || !("text" in block)) return [];
    const text = block.text;
    return typeof text === "object" && text !== null && "text" in text && typeof text.text === "string" ? [text.text] : [];
  }).join("\n").slice(0, 6_000);
}
