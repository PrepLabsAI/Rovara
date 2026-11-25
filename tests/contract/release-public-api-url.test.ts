// CODE-PUBLIC-URL (owner DEC 254zzz505, rev 9.2): the production release feeds the address stack's PublicApiOrigin output to every create and update of the control plane, and refuses an
// empty value or one that differs from it. An install with no address stack is untouched (no behaviour change).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  API_ADDRESS_DOMAIN_MAX_LENGTH, LEGACY_ADDRESS_STACK_NAME, PUBLIC_API_ORIGIN_OUTPUT, PUBLIC_API_URL_MAX_LENGTH, PUBLIC_API_URL_PARAMETER, publicApiAddressStackName, publicApiUrlChangeWarning, resolvePublicApiUrl,
} from "@agentx/contracts";
import { loadPublicApiUrlContracts, parseProductionReleaseArgs, plannedPublicApiUrl } from "../../scripts/release-production.js";
import type { StackDescription } from "../../scripts/release-common.js";

const ORIGIN = "https://api.example.dev";
const OTHER = "https://api.other.dev";
const address = (origin: string | undefined): StackDescription => ({ Outputs: origin === undefined ? [] : [{ OutputKey: PUBLIC_API_ORIGIN_OUTPUT, OutputValue: origin }] });
const controlPlane = (value: string | undefined): StackDescription => ({ Parameters: value === undefined ? [] : [{ ParameterKey: PUBLIC_API_URL_PARAMETER, ParameterValue: value }] });
const foundation = (value: string | undefined, firewall = true): StackDescription => ({
  Parameters: value === undefined ? [] : [{ ParameterKey: PUBLIC_API_URL_PARAMETER, ParameterValue: value }],
  Outputs: firewall ? [{ OutputKey: "ProjectAllowListId", OutputValue: "rslvr-fdl-1" }] : [],
});
const base = { address: undefined, controlPlane: controlPlane(""), foundation: foundation("", false), proposed: undefined, required: false, confirmChange: false };

// The script loads these after its own build step (F3 cut 1: nothing from packages/ at import time); a test that calls plannedPublicApiUrl loads them first.
beforeAll(async () => { await loadPublicApiUrlContracts(); });

describe("the contract with the address stack", () => {
  it("names the output PublicApiOrigin and the stacks AgentXApiAddress and agentx-<env>-address", () => {
    expect(PUBLIC_API_ORIGIN_OUTPUT).toBe("PublicApiOrigin");
    expect(LEGACY_ADDRESS_STACK_NAME).toBe("AgentXApiAddress");
    expect(publicApiAddressStackName(undefined)).toBe("AgentXApiAddress");
    expect(publicApiAddressStackName("beta")).toBe("agentx-beta-address");
  });

  // Rebase onto the address stack (#1426): the names live once, in api-address.ts; this lane only imports them. The host limit the address stack enforces is the parameter's MaxLength less `https://`,
  // so an origin the stack outputs is never one the pipeline refuses; and public-api-url.ts declares none of the three names itself, so the two cannot drift.
  it("shares the address stack's names and host limit instead of copying them", () => {
    expect(PUBLIC_API_URL_MAX_LENGTH).toBe("https://".length + API_ADDRESS_DOMAIN_MAX_LENGTH);
    const origin = `https://${"a".repeat(API_ADDRESS_DOMAIN_MAX_LENGTH - ".dev".length)}.dev`;
    expect(origin.length).toBe(PUBLIC_API_URL_MAX_LENGTH);
    expect(resolvePublicApiUrl({ addressOrigin: origin })).toBe(origin);
    expect(() => resolvePublicApiUrl({ addressOrigin: `https://a${origin.slice("https://a".length)}x` })).toThrow();
    const source = readFileSync(fileURLToPath(new URL("../../packages/contracts/src/public-api-url.ts", import.meta.url)), "utf8");
    for (const name of ["PUBLIC_API_ORIGIN_OUTPUT", "LEGACY_ADDRESS_STACK_NAME", "publicApiAddressStackName"]) expect(source, name).not.toMatch(new RegExp(`export (const|function) ${name}\\b`, "u"));
    expect(source).toContain('from "./api-address.js"');
  });
});

describe("resolvePublicApiUrl (the rebuild guard)", () => {
  it("no address stack: leaves the parameter as the caller has it (nothing, an empty value, or a well-formed one)", () => {
    expect(resolvePublicApiUrl({ addressOrigin: undefined })).toBeUndefined();
    expect(resolvePublicApiUrl({ addressOrigin: undefined, proposed: "" })).toBe("");
    expect(resolvePublicApiUrl({ addressOrigin: undefined, proposed: ORIGIN })).toBe(ORIGIN);
    expect(() => resolvePublicApiUrl({ addressOrigin: undefined, proposed: "https://Bad/path" })).toThrow(/must be empty or https/u);
  });
  it("an address stack: its output is the value, and an absent proposal takes it", () => {
    expect(resolvePublicApiUrl({ addressOrigin: ORIGIN })).toBe(ORIGIN);
    expect(resolvePublicApiUrl({ addressOrigin: ORIGIN, proposed: ORIGIN })).toBe(ORIGIN);
  });
  it("refuses an empty proposal and a different one, naming both addresses", () => {
    expect(() => resolvePublicApiUrl({ addressOrigin: ORIGIN, proposed: "" })).toThrow(/is empty but the address stack's PublicApiOrigin is https:\/\/api\.example\.dev/u);
    expect(() => resolvePublicApiUrl({ addressOrigin: ORIGIN, proposed: OTHER })).toThrow(/does not equal the address stack's PublicApiOrigin/u);
  });
  it("refuses an address stack whose output is empty or not an origin", () => {
    for (const addressOrigin of ["", "api.example.dev", "https://api.example.dev/", "http://api.example.dev"]) expect(() => resolvePublicApiUrl({ addressOrigin })).toThrow(/output is empty or not an https origin/u);
  });
  it("an install declared to have an address stack refuses to proceed without one", () => {
    expect(() => resolvePublicApiUrl({ addressOrigin: undefined, required: true })).toThrow(/declared to have an address stack, but none was found/u);
    expect(resolvePublicApiUrl({ addressOrigin: ORIGIN, required: true })).toBe(ORIGIN);
  });
});

describe("publicApiUrlChangeWarning (the running-install guard)", () => {
  it("is silent for a fresh install and for no change, and names the issuer consequences otherwise", () => {
    expect(publicApiUrlChangeWarning(undefined, ORIGIN)).toBeUndefined();
    expect(publicApiUrlChangeWarning(ORIGIN, ORIGIN)).toBeUndefined();
    expect(publicApiUrlChangeWarning("", undefined)).toBeUndefined();
    for (const [current, proposed] of [["", ORIGIN], [ORIGIN, OTHER], [ORIGIN, ""]] as const) {
      const warning = publicApiUrlChangeWarning(current, proposed)!;
      expect(warning).toMatch(/token issuer/u);
      expect(warning).toMatch(/sealed company AI keys, spend meters and Bedrock external ids/u);
      expect(warning).toMatch(/CodeUrl/u);
    }
  });
});

describe("the production release plans PublicApiUrl before it deploys anything", () => {
  it("no address stack and nothing proposed: sends nothing (the URLs stay the raw host)", () => {
    expect(plannedPublicApiUrl(base)).toBeUndefined();
  });
  it("feeds the address stack's origin to the control plane, on a running install only with the confirm", () => {
    const running = { ...base, address: address(ORIGIN), foundation: foundation(ORIGIN) };
    expect(() => plannedPublicApiUrl(running)).toThrow(/changes its token issuer/u);
    expect(() => plannedPublicApiUrl(running)).toThrow(/--confirm-public-api-url-change/u);
    expect(plannedPublicApiUrl({ ...running, confirmChange: true })).toBe(ORIGIN);
    // Once it is the running value nothing needs confirming: every later release carries it.
    expect(plannedPublicApiUrl({ ...running, controlPlane: controlPlane(ORIGIN) })).toBe(ORIGIN);
  });
  it("a control plane rebuilt with an empty PublicApiUrl is refused where the address stack exists", () => {
    expect(() => plannedPublicApiUrl({ ...base, address: address(ORIGIN), foundation: foundation(ORIGIN), proposed: "", confirmChange: true })).toThrow(/refusing to create or update the control plane with the raw API host/u);
  });
  it("a PublicApiUrl that differs from the address stack's output is refused", () => {
    expect(() => plannedPublicApiUrl({ ...base, address: address(ORIGIN), foundation: foundation(ORIGIN), proposed: OTHER, confirmChange: true })).toThrow(/does not equal the address stack's PublicApiOrigin/u);
  });
  it("an address stack with no output, or none at all where one is required, is refused", () => {
    expect(() => plannedPublicApiUrl({ ...base, address: address(undefined) })).toThrow(/output is empty/u);
    expect(() => plannedPublicApiUrl({ ...base, required: true })).toThrow(/declared to have an address stack/u);
  });
  it("refuses a foundation whose DNS firewall does not allow the host, with the fix (production runs the firewall in block)", () => {
    for (const onFirewall of [undefined, "", OTHER]) {
      expect(() => plannedPublicApiUrl({ ...base, address: address(ORIGIN), controlPlane: controlPlane(ORIGIN), foundation: foundation(onFirewall) })).toThrow(/Deploy the foundation with PublicApiUrl=https:\/\/api\.example\.dev first/u);
    }
    // No firewall on the foundation (the legacy default): nothing to check.
    expect(plannedPublicApiUrl({ ...base, address: address(ORIGIN), controlPlane: controlPlane(ORIGIN), foundation: foundation(undefined, false) })).toBe(ORIGIN);
  });
  it("accepts the flags", () => {
    expect(parseProductionReleaseArgs([], {})).toMatchObject({ requirePublicApiAddress: false, confirmPublicApiUrlChange: false });
    expect(parseProductionReleaseArgs(["--require-public-api-address", "--confirm-public-api-url-change"], {})).toMatchObject({ requirePublicApiAddress: true, confirmPublicApiUrlChange: true });
  });
});

describe("the production release's wiring", () => {
  const source = readFileSync("scripts/release-production.ts", "utf8");
  it("decides the value before anything is deployed, then sends it with every control plane deploy (create or update) and to the orchestrator", () => {
    const planned = source.indexOf("const publicApiUrl = plannedPublicApiUrl(readPublicApiInputs(runner, options));");
    expect(planned).toBeGreaterThan(-1);
    expect(planned).toBeLessThan(source.indexOf("deployFoundation(runner, options);"));
    expect(planned).toBeLessThan(source.indexOf("\n    RUNTIME_STACK,\n"));
    expect(source).toContain("...publicApiUrlArguments(publicApiUrl),");
    expect(source).toContain("[\"--parameters\", `${CONTROL_PLANE_STACK}:${PUBLIC_API_URL_PARAMETER}=${publicApiUrl}`]");
    expect(source).toContain('...parameter("ControlPlaneUrl", orchestratorControlPlaneUrl(publicApiUrl, () => stackOutput(controlPlane, "ApiEndpoint"))),');
    expect(source.match(/deployControlPlane\(/gu)).toHaveLength(2);
  });
  it("loads the contracts it needs only after its own build, before any use (F3 cut 1: no packages/ import at the top)", () => {
    expect(source).not.toMatch(/^import .*packages\//mu);
    const build = source.indexOf('runner.run("npm", ["run", "build"]);');
    const load = source.indexOf("await loadPublicApiUrlContracts();");
    expect(build).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(build);
    for (const use of ["const publicApiUrl = plannedPublicApiUrl(readPublicApiInputs(runner, options));", "deployControlPlane(runner, options, foundation"]) expect(source.indexOf(use), use).toBeGreaterThan(load);
    // Everything that uses a loaded name sits in a function releaseProduction reaches only after that point.
    const releaseStart = source.indexOf("export async function releaseProduction(");
    expect(source.slice(0, releaseStart).match(/^[^/\n]*\b(plannedPublicApiUrl|readPublicApiInputs)\(/gmu)?.filter((line) => !line.includes("function")) ?? []).toEqual([]);
  });
  it("it names the same strings as the address stack and the control plane parameter", () => {
    expect([LEGACY_ADDRESS_STACK_NAME, PUBLIC_API_ORIGIN_OUTPUT, PUBLIC_API_URL_PARAMETER]).toEqual(["AgentXApiAddress", "PublicApiOrigin", "PublicApiUrl"]);
  });
  it("reads the legacy address stack AgentXApiAddress, and AGENTX_PUBLIC_API_URL as the proposal the guard checks", () => {
    expect(source).toContain("address: describeIfExists(runner, options.region, LEGACY_ADDRESS_STACK_NAME),");
    expect(source).toContain("proposed: process.env.AGENTX_PUBLIC_API_URL,");
  });
});
