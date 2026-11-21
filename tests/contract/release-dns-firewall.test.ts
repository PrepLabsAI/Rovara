// #1277: production's foundation was deployed with `-c agentxDnsFirewall=watch` and an extra allowed domain, but no release path carried that context, so every release synthesized
// the firewall away and the drift guard refused it. The legacy foundation now outputs the setting it was deployed with, and the release reads it back into the same context.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { DNS_FIREWALL_CONTEXT_KEY, DNS_FIREWALL_MODE_OUTPUT, EGRESS_ALLOW_DOMAINS_CONTEXT_KEY, EGRESS_ALLOW_DOMAINS_OUTPUT } from "../../infra/lib/agent-dns-firewall.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { foundationFirewallContext } from "../../scripts/release-production.js";
import type { StackDescription } from "../../scripts/release-common.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type TemplateJson = { Resources: Record<string, unknown>; Outputs?: Record<string, { Value: unknown }> };
function foundationTemplate(context: Record<string, unknown>): TemplateJson {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && /foundation/i.test(child.stackName));
  if (stack === undefined) throw new Error("no foundation stack");
  return Template.fromStack(stack).toJSON() as TemplateJson;
}
/** What `describe-stacks` returns for a deployed template: its literal outputs (the token ones get placeholder values). */
function deployed(template: TemplateJson): StackDescription {
  return { Outputs: Object.entries(template.Outputs ?? {}).map(([key, output]) => ({ OutputKey: key, OutputValue: typeof output.Value === "string" ? output.Value : "resolved" })) };
}
/** The `-c key=value` pairs a release passes, back into a CDK context. */
function asContext(args: readonly string[]): Record<string, string> {
  const context: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    expect(args[index]).toBe("-c");
    const [key, ...value] = args[index + 1]!.split("=");
    context[key!] = value.join("=");
  }
  return context;
}

describe("a release keeps the legacy foundation's DNS firewall (#1277)", () => {
  it("watch with an extra domain: the foundation records both, and the release synthesizes the identical template", () => {
    const deployedWith = { [DNS_FIREWALL_CONTEXT_KEY]: "watch", [EGRESS_ALLOW_DOMAINS_CONTEXT_KEY]: "gateway.example.dev" };
    const live = foundationTemplate(deployedWith);
    expect(live.Outputs?.[DNS_FIREWALL_MODE_OUTPUT]?.Value).toBe("watch");
    expect(live.Outputs?.[EGRESS_ALLOW_DOMAINS_OUTPUT]?.Value).toBe("gateway.example.dev");
    const context = asContext(foundationFirewallContext(deployed(live)));
    expect(context).toEqual(deployedWith);
    expect(foundationTemplate(context)).toEqual(live);
  });

  it("block with no extra domain: only the mode is recorded and carried", () => {
    const live = foundationTemplate({ [DNS_FIREWALL_CONTEXT_KEY]: "block" });
    expect(live.Outputs?.[EGRESS_ALLOW_DOMAINS_OUTPUT]).toBeUndefined();
    const args = foundationFirewallContext(deployed(live));
    expect(args).toEqual(["-c", `${DNS_FIREWALL_CONTEXT_KEY}=block`]);
    expect(foundationTemplate(asContext(args))).toEqual(live);
  });

  it("off (the default): no outputs and no context, so the legacy template is unchanged", () => {
    const live = foundationTemplate({});
    expect(Object.keys(live.Outputs ?? {})).not.toContain(DNS_FIREWALL_MODE_OUTPUT);
    expect(foundationFirewallContext(deployed(live))).toEqual([]);
  });

  it("refuses a foundation that has a firewall but no recorded mode, instead of guessing watch or block", () => {
    expect(() => foundationFirewallContext({ Outputs: [{ OutputKey: "ProjectAllowListId", OutputValue: "rslvr-fdl-1" }] }))
      .toThrow(/has a DNS firewall but does not record its mode/u);
    expect(() => foundationFirewallContext({ Outputs: [{ OutputKey: DNS_FIREWALL_MODE_OUTPUT, OutputValue: "allow-all" }] })).toThrow(/must be off, watch or block/u);
  });

  it("a named environment's foundation does not gain the outputs", () => {
    const outputs = Object.keys(foundationTemplate({ agentxEnv: "staging" }).Outputs ?? {});
    expect(outputs).not.toContain(DNS_FIREWALL_MODE_OUTPUT);
    expect(outputs).not.toContain(EGRESS_ALLOW_DOMAINS_OUTPUT);
  });
});
