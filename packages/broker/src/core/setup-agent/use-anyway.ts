// A person's tick on a command row the page said does not match the code ("tick to use it anyway"). Only a row whose cited lines are in the file but do not hold one of its commands can be ticked this way: the
// broker then NAMES that command (`unmatched`). A row whose cited quote is not in the file at all (a wrong citation: the agent misread the files) has no named command and stays out, whatever the request says;
// the person re-runs setup or changes the command instead (DEC 254zzz586).
import { setupItemsOf, type SetupVerification } from "@agentx/contracts";

/**
 * The verdicts with the command items a person ticked anyway moved from `unverified` to `unchecked`: the person's own explicit choice, counted as such and nothing more. The item must be a setup or tests item, be in
 * `itemIds` (ticked) and in `useAnyway`, hold the verdict `unverified` and have a named unmatched command. Pure.
 */
export function verdictsWithUseAnyway(
  proposal: Parameters<typeof setupItemsOf>[0], verification: Readonly<Record<string, SetupVerification>>, itemIds: readonly string[] | undefined, useAnyway: readonly string[] | undefined,
  unmatched: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, SetupVerification>> {
  if (itemIds === undefined || useAnyway === undefined || useAnyway.length === 0) return verification;
  const allowed = new Set(setupItemsOf(proposal).filter((item) => item.kind === "setup" || item.kind === "tests").map((item) => item.id));
  const moved: Record<string, SetupVerification> = { ...verification };
  for (const id of useAnyway) if (itemIds.includes(id) && allowed.has(id) && verification[id] === "unverified" && unmatched?.[id] !== undefined) moved[id] = "unchecked";
  return moved;
}
