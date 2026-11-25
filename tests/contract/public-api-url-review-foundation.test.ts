// Opus review (CODE-PUBLIC-URL), uncommitted: which foundation layouts gain the PublicApiUrl template change, and the exact resource the one allow-list entry lands in.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { resolverOf, templateOf } from "../support/template-resolve.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const foundation = (context: Record<string, unknown>) => {
  const app = buildAgentXApp(context);
  return templateOf(Template.fromStack(app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXProductionFoundation")!));
};

describe("review: foundation layouts and PublicApiUrl", () => {
  it("legacy layout, firewall off (default, beta today): no PublicApiUrl parameter, no condition, no reference anywhere", () => {
    const t = foundation({});
    expect(t.Parameters?.PublicApiUrl).toBeUndefined();
    expect(JSON.stringify(t)).not.toContain("PublicApiUrl");
  });

  for (const mode of ["watch", "block"] as const) {
    it(`legacy layout, firewall ${mode} (prod, if its DnsFirewallMode output says so): parameter + condition + ONE If entry, in the AllowList FirewallDomainList only`, () => {
      const t = foundation({ agentxDnsFirewall: mode });
      expect(t.Parameters?.PublicApiUrl).toBeDefined();
      expect(Object.keys(t.Conditions ?? {})).toContain("HasPublicApiUrl");
      const referencing = Object.entries(t.Resources).filter(([, resource]) => JSON.stringify(resource).includes("PublicApiUrl"));
      expect(referencing.map(([id, resource]) => [id.replace(/[0-9A-F]{8}$/u, ""), resource.Type])).toEqual([["AgentDnsFirewallAllowList", "AWS::Route53Resolver::FirewallDomainList"]]);
      expect(JSON.stringify(t.Outputs ?? {})).not.toContain("PublicApiUrl");
      process.stdout.write(`REVIEW allow-list logical id (${mode}): ${referencing[0]![0]}\n`);
      const resolve = resolverOf(t, {});
      const unset = resolve((referencing[0]![1].Properties as { Domains: unknown }).Domains) as string[];
      const set = resolverOf(t, { PublicApiUrl: "https://api.example.dev" })((referencing[0]![1].Properties as { Domains: unknown }).Domains) as string[];
      expect(set.filter((d) => !unset.includes(d))).toEqual(["api.example.dev"]);
      expect(set.length).toBe(unset.length + 1);
    });
  }
});
