// Owner 2026-11-20: the legacy production install may switch on the DNS firewall that named environments already have, and any install may run its last rule in watch mode
// (ALERT: a name outside the lists is logged but still resolves) before blocking. Absent the context, the legacy template is unchanged (legacy-templates.test.ts snapshots it)
// and a named environment keeps blocking.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { DNS_FIREWALL_CONTEXT_KEY, dnsFirewallMode } from "../../infra/lib/agent-dns-firewall.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resources = Record<string, { Type: string; Properties: Record<string, unknown> }>;
function foundation(context: Record<string, unknown>): Resources {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && /foundation/i.test(child.stackName));
  if (stack === undefined) throw new Error("no foundation stack");
  return Template.fromStack(stack).toJSON().Resources as Resources;
}
const ofType = (resources: Resources, type: string) => Object.values(resources).filter((resource) => resource.Type === type);
const lastRule = (resources: Resources) => {
  const [group] = ofType(resources, "AWS::Route53Resolver::FirewallRuleGroup");
  const rules = (group!.Properties.FirewallRules as Array<Record<string, unknown>>);
  return rules.find((rule) => rule.Priority === 200);
};

describe("DNS firewall mode (agentxDnsFirewall)", () => {
  it("is off by default for the legacy install and block by default for a named environment", () => {
    expect(dnsFirewallMode(undefined, true)).toBe("off");
    expect(dnsFirewallMode(undefined, false)).toBe("block");
    expect(dnsFirewallMode("watch", true)).toBe("watch");
    expect(dnsFirewallMode("block", true)).toBe("block");
    expect(dnsFirewallMode("watch", false)).toBe("watch");
  });

  it("refuses an unknown value, and off for a named environment, without echoing the value", () => {
    expect(() => dnsFirewallMode("allow-all", true)).toThrow(/^agentxDnsFirewall must be off, watch or block$/u);
    expect(() => dnsFirewallMode(true, true)).toThrow(/must be off, watch or block/u);
    expect(() => dnsFirewallMode("off", false)).toThrow(/only for the legacy production install/u);
  });
});

describe("the legacy production install's DNS firewall", () => {
  it("is absent unless asked: no Resolver firewall, query logging or egress alarm", () => {
    const resources = foundation({});
    expect(Object.values(resources).filter((resource) => resource.Type.startsWith("AWS::Route53Resolver::"))).toEqual([]);
    expect(JSON.stringify(resources)).not.toContain("dns-firewall");
    expect(JSON.stringify(resources)).not.toContain("blocked-dns-spike");
  });

  it("watch: the full firewall under the legacy names, the last rule only ALERTs, the extra domain is allowed, alarms go to the existing topic", () => {
    const resources = foundation({ [DNS_FIREWALL_CONTEXT_KEY]: "watch", agentxEgressAllowDomains: "gateway.example.dev" });
    const [group] = ofType(resources, "AWS::Route53Resolver::FirewallRuleGroup");
    expect(group!.Properties.Name).toBe("agentx-production-agents");
    const rule = lastRule(resources)!;
    expect(Object.keys(rule).sort()).toEqual(["Action", "FirewallDomainListId", "Priority"]);
    expect([rule.Action, rule.Priority]).toEqual(["ALERT", 200]);
    const lists = ofType(resources, "AWS::Route53Resolver::FirewallDomainList").map((list) => list.Properties);
    expect(lists.map((list) => list.Name).sort()).toEqual(["agentx-production-allow", "agentx-production-block-all", "agentx-production-project-allow"]);
    const allow = lists.find((list) => list.Name === "agentx-production-allow")!.Domains as string[];
    expect(allow).toContain("gateway.example.dev");
    expect(allow).toContain("github.com");
    expect(ofType(resources, "AWS::Route53Resolver::FirewallRuleGroupAssociation")).toHaveLength(1);
    expect(ofType(resources, "AWS::Logs::LogGroup").map((group) => group.Properties.LogGroupName)).toContain("/agentx/production/dns-firewall");
    const alarms = ofType(resources, "AWS::CloudWatch::Alarm").map((alarm) => alarm.Properties);
    expect(alarms.map((alarm) => alarm.AlarmName)).toContain("agentx-production-blocked-dns-spike");
    expect(JSON.stringify(alarms)).toContain(":AgentXOperatorAlerts");
  });

  it("block: the same firewall, the last rule answers NXDOMAIN", () => {
    const rule = lastRule(foundation({ [DNS_FIREWALL_CONTEXT_KEY]: "block" }))!;
    expect(Object.keys(rule).sort()).toEqual(["Action", "BlockResponse", "FirewallDomainListId", "Priority"]);
    expect([rule.Action, rule.BlockResponse, rule.Priority]).toEqual(["BLOCK", "NXDOMAIN", 200]);
  });

  it("watch and block differ only in that one rule, so switching from watch to block updates the rule group in place", () => {
    // The priority-200 rule taken out of each template (it must be the one thing that differs); everything else compared as data.
    const strip = (resources: Resources) => {
      const copy = structuredClone(resources);
      for (const resource of Object.values(copy)) {
        if (resource.Type !== "AWS::Route53Resolver::FirewallRuleGroup") continue;
        resource.Properties.FirewallRules = (resource.Properties.FirewallRules as Array<Record<string, unknown>>).map((rule) => (rule.Priority === 200 ? { Priority: 200, list: rule.FirewallDomainListId } : rule));
      }
      return copy;
    };
    expect(strip(foundation({ [DNS_FIREWALL_CONTEXT_KEY]: "watch" }))).toEqual(strip(foundation({ [DNS_FIREWALL_CONTEXT_KEY]: "block" })));
  });
});

describe("a named environment's DNS firewall", () => {
  it("still blocks by default, and can watch", () => {
    expect(lastRule(foundation({ agentxEnv: "staging" }))).toMatchObject({ Action: "BLOCK", BlockResponse: "NXDOMAIN" });
    expect(lastRule(foundation({ agentxEnv: "staging", [DNS_FIREWALL_CONTEXT_KEY]: "watch" }))).toMatchObject({ Action: "ALERT" });
  });
});
