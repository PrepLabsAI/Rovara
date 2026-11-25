import { readFileSync } from "node:fs";

/**
 * F1 L1a-1: the parameters the kept-on-upgrade set grew by, read from the two golden lists (the base taken before L1a-0 and what the lists are now), so a test per addition cannot drift
 * from the list it tests. Each is `{ part, name }`.
 */
export function keptAdditionsOfL1a1(): Array<{ part: string; name: string }> {
  const read = (file: string) => (JSON.parse(readFileSync(`tests/contract/golden/${file}`, "utf8")) as { operatorParameters: Record<string, string[]> }).operatorParameters;
  const before = read("install-settings.base.golden.json");
  const now = read("install-settings.golden.json");
  return Object.entries(now).flatMap(([part, names]) => names.filter((name) => !(before[part] ?? []).includes(name)).map((name) => ({ part, name })));
}
