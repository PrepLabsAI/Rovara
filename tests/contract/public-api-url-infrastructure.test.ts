// CODE-PUBLIC-URL (owner DEC 254zzz505): one configured public address for the control plane's API. With the stack parameter PublicApiUrl set, every external URL the control plane
// builds uses it; with it empty (the default) each is today's raw API host, so an install that does not set it changes in no way. The legacy and the named control plane are both
// synthesized, filled in with the parameter empty and set, and compared site by site. The DNS firewall's base allow list gains the host (rev 9.2), tested on the named foundation.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { PUBLIC_API_URL_MAX_LENGTH, PUBLIC_API_URL_PATTERN, isPublicApiUrl } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { installAgentAllowDomains, publicApiAllowDomain } from "../../infra/lib/agent-dns-firewall.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { RAW_API_ENDPOINT, REGION, resolvedValues, resolverOf, templateOf, type ResolvableTemplate } from "../support/template-resolve.js";

skipLambdaBundling();

const PUBLIC = "https://api.example.dev";
type Site = { where: string; name: string; path: string };
/** Every external URL site of the control plane, as `<function or Output>.<variable>` and the path after the base ("" is the base itself). */
const SHARED_SITES: Site[] = [
  { where: "Dispatcher", name: "DEVELOPER_TOKEN_ISSUER", path: "/v1/auth" },
  { where: "DeveloperSignInFunction", name: "DEVELOPER_TOKEN_ISSUER", path: "/v1/auth" },
  { where: "SlackIngress", name: "CHANNEL_API_URL", path: "" },
  { where: "ChannelApiIngress", name: "CHANNEL_LINK_ORIGIN", path: "" },
  { where: "ChannelApiIngress", name: "BUILT_IN_ADAPTER_CALLBACK_URL", path: "/v1/slack/channel-events" },
  { where: "ChannelApiIngress", name: "BUILT_IN_ADAPTER_COMMANDS_URL", path: "/v1/slack/channel-commands" },
  { where: "ChannelApiEventSender", name: "BUILT_IN_ADAPTER_CALLBACK_URL", path: "/v1/slack/channel-events" },
  { where: "ChannelApiEventSender", name: "BUILT_IN_ADAPTER_COMMANDS_URL", path: "/v1/slack/channel-commands" },
  { where: "DeveloperSignInFunction", name: "BUILT_IN_ADAPTER_CALLBACK_URL", path: "/v1/slack/channel-events" },
  { where: "DeveloperSignInFunction", name: "BUILT_IN_ADAPTER_COMMANDS_URL", path: "/v1/slack/channel-commands" },
  { where: "DeveloperTaskNotifierFunction", name: "CONTROL_PLANE_URL", path: "" },
  { where: "DeveloperTaskNotifierFunction", name: "BUILT_IN_ADAPTER_CALLBACK_URL", path: "/v1/slack/channel-events" },
  { where: "DeveloperTaskNotifierFunction", name: "BUILT_IN_ADAPTER_COMMANDS_URL", path: "/v1/slack/channel-commands" },
  { where: "SessionsSteps", name: "CONTROL_PLANE_URL", path: "" },
  { where: "SessionsReconciler", name: "BUILT_IN_ADAPTER_CALLBACK_URL", path: "/v1/slack/channel-events" },
  { where: "SessionsReconciler", name: "BUILT_IN_ADAPTER_COMMANDS_URL", path: "/v1/slack/channel-commands" },
  { where: "Output", name: "SlackAdapterCommandsUrl", path: "/v1/slack/channel-commands" },
  { where: "Output", name: "DeveloperSignInIssuer", path: "/v1/auth" },
  { where: "Output", name: "SlackEventsUrl", path: "/v1/slack/events" },
  { where: "Output", name: "GithubWebhookUrl", path: "/v1/github/webhooks" },
  { where: "Output", name: "SlackInteractivityUrl", path: "/v1/slack/interactions" },
];
/** The named control plane's own: the broker itself is given the adapter URLs whole, and the Linear webhook route (named environments only) has its output. */
const LEGACY_ONLY_SITES: Site[] = [
  // CANARY-SESSION: the beta canary's session function (legacy layout only; it exists only while its settings are given, but its variable is in the template) signs for the same issuer.
  { where: "DeveloperSignInCanarySessionFunction", name: "DEVELOPER_TOKEN_ISSUER", path: "/v1/auth" },
  { where: "DeveloperSignInCanarySessionFunction", name: "CANARY_ISSUER", path: "/v1/auth" },
];
const NAMED_ONLY_SITES: Site[] = [
  { where: "Broker", name: "BUILT_IN_ADAPTER_CALLBACK_URL", path: "/v1/slack/channel-events" },
  { where: "Broker", name: "BUILT_IN_ADAPTER_COMMANDS_URL", path: "/v1/slack/channel-commands" },
  { where: "Output", name: "LinearWebhookUrl", path: "/v1/linear/webhooks" },
];

const synthesized = (env: string | undefined, id: string): Stack => {
  const app = buildAgentXApp(env === undefined ? {} : { agentxEnv: env });
  return app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === id)!;
};

for (const layout of [{ label: "the legacy control plane", env: undefined, sites: [...SHARED_SITES, ...LEGACY_ONLY_SITES] }, { label: "the named control plane", env: "staging", sites: [...SHARED_SITES, ...NAMED_ONLY_SITES] }] as const) {
  describe(`${layout.label}: PublicApiUrl`, () => {
    const template: ResolvableTemplate = templateOf(Template.fromStack(synthesized(layout.env, "AgentXControlPlane")));
    const unset = resolvedValues(template);
    const set = resolvedValues(template, { PublicApiUrl: PUBLIC });
    const find = (values: typeof unset, site: Site) => values.filter((value) => value.where === site.where && value.name === site.name);

    it("is a parameter that defaults to empty and takes only an https origin, with a condition on it", () => {
      expect(template.Parameters!.PublicApiUrl).toMatchObject({ Type: "String", Default: "", AllowedPattern: PUBLIC_API_URL_PATTERN, MaxLength: PUBLIC_API_URL_MAX_LENGTH });
      expect(template.Conditions!.HasPublicApiUrl).toStrictEqual({ "Fn::Not": [{ "Fn::Equals": [{ Ref: "PublicApiUrl" }, ""] }] });
    });

    it("with it empty, each external URL is the API's own host, exactly as before (every site, no extra and none missing)", () => {
      for (const site of layout.sites) {
        const found = find(unset, site);
        expect(found, `${site.where}.${site.name}`).toHaveLength(1);
        expect(found[0]!.value, `${site.where}.${site.name}`).toBe(`${RAW_API_ENDPOINT}${site.path}`);
      }
      // No other variable or output holds the raw host but the ApiEndpoint output, which names the API itself.
      const others = unset.filter((value) => value.value.includes(RAW_API_ENDPOINT) && !layout.sites.some((site) => site.where === value.where && site.name === value.name));
      expect(others.map((value) => `${value.where}.${value.name}`)).toEqual(["Output.ApiEndpoint"]);
      expect(unset.find((value) => value.where === "Output" && value.name === "ApiEndpoint")!.value).toBe(RAW_API_ENDPOINT);
    });

    it("with it set, each external URL uses the configured base, and nothing but the raw ApiEndpoint output names the API's own host", () => {
      for (const site of layout.sites) {
        const found = find(set, site);
        expect(found, `${site.where}.${site.name}`).toHaveLength(1);
        expect(found[0]!.value, `${site.where}.${site.name}`).toBe(`${PUBLIC}${site.path}`);
      }
      expect(set.filter((value) => value.value.includes(RAW_API_ENDPOINT)).map((value) => `${value.where}.${value.name}`)).toEqual(["Output.ApiEndpoint"]);
    });

    it("keeps the raw ApiEndpoint output when it is set (what a rebuilt API changes)", () => {
      expect(set.find((value) => value.where === "Output" && value.name === "ApiEndpoint")!.value).toBe(RAW_API_ENDPOINT);
    });

    it("the issuer and the sign-in callbacks follow the public base: the sign-in function, the dispatcher and the broker all hold the same issuer", () => {
      const issuers = new Set(["DeveloperSignInFunction", "Dispatcher"].map((where) => find(set, { where, name: "DEVELOPER_TOKEN_ISSUER", path: "" })[0]!.value));
      expect([...issuers]).toEqual([`${PUBLIC}/v1/auth`]);
      // The broker is given the host packed (AGENTX_SETTINGS, `pu`), empty while the parameter is empty, and derives its issuer from it (tests/contract/broker-environment.test.ts).
      const settings = (values: typeof set) => values.find((value) => /^Broker$/u.test(value.where) && value.name === "AGENTX_SETTINGS")!.value;
      expect(settings(set)).toContain(",pu=api.example.dev,");
      expect(settings(unset)).toContain(",pu=,");
      expect(settings(set).replace(",pu=api.example.dev,", ",pu=,")).toBe(settings(unset));
    });

    it("has the Linear webhook output only where the route exists", () => {
      const linear = template.Outputs!.LinearWebhookUrl;
      if (layout.env === undefined) expect(linear).toBeUndefined();
      else expect(linear).toBeDefined();
    });
  });
}

describe("the PublicApiUrl parameter's pattern", () => {
  it.each(["", "https://api.example.com", "https://api.beta.example.com", "https://a-b.example.com"])("accepts %j", (value) => {
    expect(isPublicApiUrl(value)).toBe(true);
    expect(new RegExp(PUBLIC_API_URL_PATTERN, "u").test(value)).toBe(true);
  });
  it.each(["http://api.example.com", "https://api.example.com/", "https://api.example.com/v1", "https://api.example.com:8443", "https://API.example.com", "https://user@api.example.com", "https://localhost", "api.example.com", "https://api example.com", "https://api.example.com?x=1", "https://-api.example.com", `https://${"a".repeat(70)}.dev`])("refuses %j", (value) => {
    expect(isPublicApiUrl(value)).toBe(false);
  });
});

describe("the DNS firewall's base allow list (rev 9.2)", () => {
  const foundation = synthesized("staging", "AgentXProductionFoundation");
  const template = templateOf(Template.fromStack(foundation));
  const allowList = (parameters: Record<string, string>): string[] => {
    const resolve = resolverOf(template, parameters);
    const list = Object.values(template.Resources).find((resource) => resource.Type === "AWS::Route53Resolver::FirewallDomainList" && String((resource.Properties as { Name: string }).Name).endsWith("-allow"))!;
    return resolve((list.Properties as { Domains: unknown }).Domains) as string[];
  };

  it("declares the same parameter as the control plane, with the same pattern and an empty default", () => {
    expect(template.Parameters!.PublicApiUrl).toMatchObject({ Type: "String", Default: "", AllowedPattern: PUBLIC_API_URL_PATTERN, MaxLength: PUBLIC_API_URL_MAX_LENGTH });
  });

  it("with PublicApiUrl set, holds exactly that host, once, as an exact name, beside the control plane's execute-api wildcard", () => {
    const domains = allowList({ PublicApiUrl: PUBLIC });
    expect(domains.filter((domain) => domain === "api.example.dev")).toEqual(["api.example.dev"]);
    expect(domains.filter((domain) => domain.includes("example.dev"))).toEqual(["api.example.dev"]);
    expect(domains).toContain(`*.execute-api.${REGION}.amazonaws.com`);
    // Exactly one entry is new, and it is not a wildcard.
    expect(domains.filter((domain) => !allowList({}).includes(domain))).toEqual(["api.example.dev"]);
  });

  it("unset, does not hold it, and the list is exactly the set list without it (the foundation's recorded snapshot proves it is also what it was before this lane)", () => {
    const domains = allowList({});
    expect(domains.some((domain) => domain.includes("example.dev"))).toBe(false);
    expect(allowList({ PublicApiUrl: PUBLIC }).filter((domain) => domain !== "api.example.dev")).toEqual(domains);
  });

  it("the same value in both stacks gives the same host: the foundation's entry is the host the control plane's broker holds", () => {
    const hostOfFoundation = allowList({ PublicApiUrl: "https://api.beta.example.com" }).filter((domain) => domain.endsWith("beta.example.com"));
    expect(hostOfFoundation).toEqual(["api.beta.example.com"]);
  });
});

describe("publicApiAllowDomain", () => {
  it("adds nothing without a host, and one exact lowercase name with one", () => {
    expect(publicApiAllowDomain(undefined)).toEqual([]);
    expect(publicApiAllowDomain("api.example.com")).toEqual(["api.example.com"]);
    expect(installAgentAllowDomains("us-east-1", undefined, "api.example.com").filter((domain) => domain === "api.example.com")).toEqual(["api.example.com"]);
    expect(installAgentAllowDomains("us-east-1").includes("api.example.com")).toBe(false);
  });
  it.each(["*.example.com", "*", "API.example.com", "api.example.com:8443", "api.example.com/", "localhost", ""])("refuses %j: never a wildcard, a port or a path", (host) => {
    expect(() => publicApiAllowDomain(host)).toThrow(/exact lowercase host name/u);
  });
});
