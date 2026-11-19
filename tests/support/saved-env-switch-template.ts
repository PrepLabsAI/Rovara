/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- a synthesized CloudFormation template is untyped JSON. */
// L4-SE (#1081, owner DEC 254zzz56/82): the saved-environment SWITCH on a named control plane. infra/lib/core-engine.ts adds ONE stack parameter, `SavedEnvironments`
// ("0" default, "1"), and packs it as `sv=` into the broker's and the dispatcher's packed settings. Digest and snapshot tests that pin the rest of the control-plane
// template assert exactly this addition here, then take it out in place, so their pins stay the ones recorded before it (rule D: removing exactly this addition
// gives back the old template). A template without the parameter (legacy) is returned as it is.
import { expect } from "vitest";

const PARAMETER = "SavedEnvironments";
const isRef = (value: unknown): boolean => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 1 && (value as any).Ref === PARAMETER;

/** Removes `sv=` + {Ref: SavedEnvironments} from one Fn::Join part list; returns how many it removed. Adjacent strings are merged again, as CDK writes them. */
function stripJoinParts(parts: unknown[]): number {
  let removed = 0;
  for (let i = 0; i + 1 < parts.length; i += 1) {
    const text = parts[i];
    if (typeof text !== "string" || !isRef(parts[i + 1])) continue;
    if (text.endsWith(",sv=")) { parts[i] = text.slice(0, -4); parts.splice(i + 1, 1); removed += 1; continue; }
    const next = parts[i + 2];
    if (text.endsWith("sv=") && typeof next === "string" && next.startsWith(",")) { parts[i] = text.slice(0, -3); parts[i + 2] = next.slice(1); parts.splice(i + 1, 1); removed += 1; continue; }
    throw new Error("saved-env switch: an sv= part in an unexpected place");
  }
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i] === "") { parts.splice(i, 1); continue; }
    if (i > 0 && typeof parts[i] === "string" && typeof parts[i - 1] === "string") { parts[i - 1] = `${parts[i - 1] as string}${parts[i] as string}`; parts.splice(i, 1); }
  }
  return removed;
}

function walk(node: unknown, visit: (parts: unknown[]) => void): void {
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return; }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "Fn::Join" && Array.isArray(value) && Array.isArray(value[1])) visit(value[1] as unknown[]);
    walk(value, visit);
  }
}

/** Asserts the switch's parameter and its two packed settings exactly, then removes them in place. */
export function withoutSavedEnvSwitch<T>(input: T): T {
  const template = input as any;
  const parameter = template?.Parameters?.[PARAMETER];
  if (parameter === undefined) {
    expect(JSON.stringify(template)).not.toContain(`"Ref":"${PARAMETER}"`);
    return input;
  }
  expect(parameter).toEqual({ Type: "String", Default: "0", AllowedValues: ["0", "1"], Description: "Saved environments: 0 (the default) or 1 when registry roles are provisioned" });
  delete template.Parameters[PARAMETER];
  let removed = 0;
  walk(template, (parts) => { removed += stripJoinParts(parts); });
  // The broker's packed settings and the dispatcher's packed settings.
  expect(removed).toBe(2);
  expect(JSON.stringify(template)).not.toContain(`"Ref":"${PARAMETER}"`);
  return input;
}
