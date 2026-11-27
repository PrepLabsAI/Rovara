// First-switch gate (#1478 phase 2, #1578): when the live gateway stack has no DeployedCodeSha output yet
// (last deployed from Cloud), the first change set made from Code's CDK app must change no resource at all.
// Templates must be equal outside Outputs; Outputs may differ only by dropping DeployedCloudSha and adding DeployedCodeSha.
import { canonicalJson } from "./hash.js";

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const SHA40 = /^[0-9a-f]{40}$/u;

export const DROPPED_OUTPUTS: readonly string[] = ["DeployedCloudSha"];
export const ADDED_OUTPUT = "DeployedCodeSha";

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const list = (names: readonly string[]): string => `${names.slice(0, 8).join(", ")}${names.length > 8 ? `, and ${names.length - 8} more` : ""}`;

function diffSection(section: string, a: unknown, b: unknown): string[] {
  if (!isObject(a) || !isObject(b)) return [`section ${section} differs`];
  const out: string[] = [];
  const added = Object.keys(b).filter((key) => !(key in a));
  const removed = Object.keys(a).filter((key) => !(key in b));
  const changed = Object.keys(a).filter((key) => key in b && !same(a[key], b[key]));
  if (added.length > 0) out.push(`${section}: added ${list(added)}`);
  if (removed.length > 0) out.push(`${section}: removed ${list(removed)}`);
  if (changed.length > 0) out.push(`${section}: changed ${list(changed)}`);
  return out;
}

function nonOutputDifferences(live: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const section of new Set([...Object.keys(live), ...Object.keys(next)])) {
    if (section === "Outputs" || same(live[section], next[section])) continue;
    found.push(...diffSection(section, live[section], next[section]));
  }
  return found;
}

export interface SwitchVerdict {
  failures: string[];
}

export function judgeGatewaySwitch(live: unknown, next: unknown, codeSha: string): SwitchVerdict {
  if (!isObject(live) || !isObject(next)) {
    return { failures: ["a template is not a JSON object, so the gateway change cannot be compared with the live stack"] };
  }
  const failures = nonOutputDifferences(live, next).map(
    (line) => `the Code-made model gateway template differs from the live stack outside Outputs (${line})`,
  );
  const before = isObject(live.Outputs) ? live.Outputs : {};
  const after = isObject(next.Outputs) ? next.Outputs : {};
  const strayRemoved = Object.keys(before).filter((key) => !(key in after) && !DROPPED_OUTPUTS.includes(key));
  const strayAdded = Object.keys(after).filter((key) => !(key in before) && key !== ADDED_OUTPUT);
  const changed = Object.keys(before).filter((key) => key in after && !same(before[key], after[key]));
  if (strayRemoved.length > 0) failures.push(`the change drops the output(s) ${list(strayRemoved)}: only ${DROPPED_OUTPUTS.join(", ")} may go`);
  if (strayAdded.length > 0) failures.push(`the change adds the output(s) ${list(strayAdded)}: only ${ADDED_OUTPUT} may be new`);
  if (changed.length > 0) failures.push(`the change alters the output(s) ${list(changed)}`);
  const recorded = isObject(after[ADDED_OUTPUT]) ? after[ADDED_OUTPUT].Value : undefined;
  if (typeof recorded !== "string" || !SHA40.test(recorded)) {
    failures.push(`the new template has no ${ADDED_OUTPUT} output with a 40-hex commit`);
  } else if (recorded !== codeSha) {
    failures.push(`${ADDED_OUTPUT} says ${recorded.slice(0, 12)}, not the Code commit ${codeSha.slice(0, 12)} the model gateway is built from`);
  }
  return { failures };
}
