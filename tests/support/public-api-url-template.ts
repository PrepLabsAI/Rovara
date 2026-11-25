import { expect } from "vitest";
import { PUBLIC_API_URL_MAX_LENGTH, PUBLIC_API_URL_PATTERN } from "@agentx/contracts";

type Json = Record<string, unknown>;
type Template = { Parameters?: Record<string, unknown>; Conditions?: Record<string, unknown>; Resources: Record<string, unknown>; Outputs?: Record<string, { Value: unknown }> };

const CONDITION = "HasPublicApiUrl";
const RAW_HOST = { "Fn::GetAtt": ["HttpApi", "ApiEndpoint"] };
const PACKED_HOST = { "Fn::Select": [1, { "Fn::Split": ["://", { Ref: "PublicApiUrl" }] }] };

function expectParameterAndCondition(template: Template): void {
  expect(template.Parameters?.PublicApiUrl).toMatchObject({ Type: "String", Default: "", MaxLength: PUBLIC_API_URL_MAX_LENGTH, AllowedPattern: PUBLIC_API_URL_PATTERN });
  expect(template.Conditions?.[CONDITION]).toStrictEqual({ "Fn::Not": [{ "Fn::Equals": [{ Ref: "PublicApiUrl" }, ""] }] });
  delete template.Parameters!.PublicApiUrl;
  delete template.Conditions![CONDITION];
  if (Object.keys(template.Conditions!).length === 0) delete template.Conditions;
  else moveSectionAfterOutputs(template, "Conditions");
}

/**
 * Where the template had other conditions before this lane, CDK wrote the Conditions section after Outputs (the first condition was created after the first output); the new condition is created
 * before them, so the section moves up. Same JSON, different key order: it is put back where it was so the recorded digests, which hash the key order, hold.
 */
function moveSectionAfterOutputs(template: Template, section: string): void {
  const entries = Object.entries(template as unknown as Json);
  const moved = entries.find(([key]) => key === section)!;
  const rest = entries.filter(([key]) => key !== section);
  const outputs = rest.findIndex(([key]) => key === "Outputs");
  if (outputs < 0) return;
  rest.splice(outputs + 1, 0, moved);
  for (const [key] of entries) delete (template as unknown as Json)[key];
  for (const [key, value] of rest) (template as unknown as Json)[key] = value;
}

const isHasPublicApiUrl = (node: unknown): node is { "Fn::If": [string, unknown, unknown] } => {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
  const entries = Object.entries(node as Json);
  return entries.length === 1 && entries[0]![0] === "Fn::If" && (entries[0]![1] as unknown[])[0] === CONDITION;
};

/**
 * CODE-PUBLIC-URL (owner DEC 254zzz505): the control plane gains exactly these changes and nothing else, each checked here to be exactly this and then taken out, so the rest of the
 * template must still match every recorded pin and snapshot:
 *  - the parameter `PublicApiUrl` (default empty) and its condition `HasPublicApiUrl`;
 *  - every external URL's base, which was `GetAtt HttpApi.ApiEndpoint`, is now `Fn::If [HasPublicApiUrl, Ref PublicApiUrl, GetAtt HttpApi.ApiEndpoint]`: with the parameter empty each
 *    resolves to the same value as before. `sites`, where given, counts them (so a URL that bypasses the helper, or a site that is dropped, moves it; a test that has already taken other additions out gives none);
 *  - the broker's packed setting `pu` (the public host, or empty), which is one more piece of AGENTX_SETTINGS;
 *  - a named environment's new output `LinearWebhookUrl` (the Linear webhook route exists only there).
 * Takes the additions out of `input` itself (like the other withoutX helpers) and returns it; clone first to keep the original.
 */
export function withoutPublicApiUrl<T>(input: T, install: { named: boolean; sites?: number }): T {
  const template = input as unknown as Template;
  expectParameterAndCondition(template);
  let unwrapped = 0;
  let packed = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const entry of node) {
        if (isHasPublicApiUrl(entry) && JSON.stringify((entry["Fn::If"] as unknown[])[1]) === JSON.stringify(PACKED_HOST)) {
          // The packed setting: `,pu=` (a literal that ends the piece before) and its value; the value is the host while set and empty otherwise.
          expect((entry["Fn::If"] as unknown[])[2]).toBe("");
          const before = out[out.length - 1];
          expect(typeof before === "string" && before.endsWith(",pu=")).toBe(true);
          const trimmed = (before as string).slice(0, -",pu=".length);
          if (trimmed === "") out.pop(); else out[out.length - 1] = trimmed;
          packed += 1;
        } else out.push(walk(entry));
      }
      return out;
    }
    if (node === null || typeof node !== "object") return node;
    if (isHasPublicApiUrl(node)) {
      const [, yes, no] = node["Fn::If"];
      expect(yes).toStrictEqual({ Ref: "PublicApiUrl" });
      expect(no).toStrictEqual(RAW_HOST);
      unwrapped += 1;
      return no;
    }
    return Object.fromEntries(Object.entries(node as Json).map(([key, value]) => [key, walk(value)]));
  };
  if (install.named) {
    const linear = template.Outputs?.LinearWebhookUrl;
    expect(linear).toBeDefined();
    expect(JSON.stringify(linear!.Value)).toBe(JSON.stringify({ "Fn::Join": ["", [{ "Fn::If": [CONDITION, { Ref: "PublicApiUrl" }, RAW_HOST] }, "/v1/linear/webhooks"]] }));
    delete template.Outputs!.LinearWebhookUrl;
  } else expect(template.Outputs?.LinearWebhookUrl).toBeUndefined();
  for (const section of ["Resources", "Outputs"]) (template as unknown as Json)[section] = walk((template as unknown as Json)[section]);
  expect(packed, "the broker's one packed public host").toBe(1);
  if (install.sites !== undefined) expect(unwrapped, "external URL bases").toBe(install.sites);
  else expect(unwrapped, "external URL bases").toBeGreaterThan(0);
  return input;
}

/**
 * CODE-PUBLIC-URL (rev 9.2): the foundation (only where it has the DNS firewall) gains the parameter `PublicApiUrl`, its condition, and ONE entry on the firewall's base allow list: the
 * parameter's host while it is set, nothing (AWS::NoValue) while it is empty, so an empty parameter leaves the list exactly as it was. Checked here to be exactly this, then taken out.
 */
export function withoutPublicApiAllowDomain<T>(input: T): T {
  const template = input as unknown as Template;
  expectParameterAndCondition(template);
  let found = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.flatMap((entry) => {
        if (isHasPublicApiUrl(entry)) {
          expect(JSON.stringify(entry)).toBe(JSON.stringify({ "Fn::If": [CONDITION, PACKED_HOST, { Ref: "AWS::NoValue" }] }));
          found += 1;
          return [];
        }
        return [walk(entry)];
      });
    }
    if (node === null || typeof node !== "object") return node;
    return Object.fromEntries(Object.entries(node as Json).map(([key, value]) => [key, walk(value)]));
  };
  template.Resources = walk(template.Resources) as Json;
  expect(found, "one allow-list entry").toBe(1);
  return input;
}
