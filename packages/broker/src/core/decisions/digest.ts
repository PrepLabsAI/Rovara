// The digest of what a person is shown on a card. "Evidence opened" and every approve are bound to it, and the CLIENT sends back the digest it was shown (`shownDigest`), so a stale view cannot
// create a fresh record and a card that changed after it was rendered must be loaded again. It covers the card, its tabs, the evidence detail AND the content version behind it (the document
// version, the pull request head): a revised plan or a new push with the same title and counts is a different digest.
import { createHash } from "node:crypto";
import { canonicalJson, type DecisionCard, type DecisionDetailGroup, type DecisionTab } from "@agentx/contracts";

export function cardDigest(card: DecisionCard, tabs: readonly DecisionTab[] | undefined, details: readonly DecisionDetailGroup[], contentVersions: readonly string[]): string {
  const seen = {
    id: card.id, kind: card.kind, title: card.title, question: card.question, next: card.next, evidence: card.evidence, risk: card.risk, riskReasons: card.riskReasons,
    tabs: tabs === undefined ? null : tabs.map((tab) => ({ id: tab.id, summary: tab.summary, evidence: tab.evidence })),
    details, contentVersions,
  };
  return createHash("sha256").update(canonicalJson(seen)).digest("hex");
}
