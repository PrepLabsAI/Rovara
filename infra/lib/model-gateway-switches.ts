/**
 * The company AI source kinds each environment's gateway deploy is run with (`-c rovaraAiSourceKinds=<kinds>`, model-gateway-app.ts),
 * kept here until the gateway deploys from Code (#1478, phase 2). The value must equal the one the website stack of the same
 * environment is deployed with: the gateway's own-Bedrock source for agents and the website's connect screen read the same list.
 *
 * - beta: `openai,bedrock`: company-key OpenAI and the company's own Bedrock for its agents (DEC 254zzz524, beta proof first).
 * - production: `openai`, as production runs today; production joins `bedrock` in its own commit, after the beta agent proof
 *   (PRODUCTION_SOURCE_KINDS allows it; PRODUCTION_SOURCE_KINDS_NAMED_REFUSAL makes a production deploy name its kinds).
 */
export type GatewaySwitchesEnvironment = "beta" | "production";

export interface GatewaySwitchesRow {
  readonly aiSourceKinds: string;
}

export interface GatewaySwitches {
  readonly environments: Readonly<Record<GatewaySwitchesEnvironment, GatewaySwitchesRow>>;
}

const SWITCHES: GatewaySwitches = Object.freeze({
  environments: Object.freeze({
    beta: Object.freeze({ aiSourceKinds: "openai,bedrock" }),
    production: Object.freeze({ aiSourceKinds: "openai" }),
  }),
});

/** The per-environment gateway settings (the same shape the gateway's route tests read the source kinds from). */
export function loadSwitches(): GatewaySwitches {
  return SWITCHES;
}

/** The `-c rovaraAiSourceKinds` value an environment's gateway deploy passes. */
export function gatewayAiSourceKinds(environment: GatewaySwitchesEnvironment): string {
  return SWITCHES.environments[environment].aiSourceKinds;
}
