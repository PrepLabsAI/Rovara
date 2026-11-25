// CODE-PUBLIC-URL (owner DEC 254zzz505, rev 9.2): which PublicApiUrl a deploy gives the stacks, and the refusals around it. Pure of AWS: the caller passes readers.
//  - Where the address stack (agentx-<env>-address) exists, its PublicApiOrigin output is the only value a create or an update of the control plane may carry; an empty value or one that
//    differs from it is refused, so a rebuilt control plane never falls back to the raw API host (contracts resolvePublicApiUrl).
//  - Setting or changing a non-empty value on a running install is an ISSUER change (Cloud's sealed company AI keys, spend meters and Bedrock external ids are keyed on the issuer), so it
//    is refused without an explicit confirm that names those consequences (contracts publicApiUrlChangeWarning).
//  - The foundation's DNS firewall must already allow the host the control plane will use (production runs the firewall in `block`): a control plane given a value the foundation does not
//    carry would have its workers and the Slack orchestrator refused.
import { controlPlaneBase, PUBLIC_API_ORIGIN_OUTPUT, PUBLIC_API_URL_PARAMETER, agentXError, environmentStackName, publicApiAddressStackName, publicApiUrlChangeWarning, resolvePublicApiUrl } from "@agentx/contracts";
import type { DeployPart, StackOutputs } from "./parameters.js";

export interface PublicApiUrlPlanInput {
  env: string;
  mode: "install" | "upgrade";
  deploySet: ReadonlySet<DeployPart>;
  /** The answers' own value (a settings row once F1 lands), if any. */
  proposed: string | undefined;
  /** This install is declared to have an address stack: a deploy that finds none is refused. */
  required: boolean;
  /** The operator confirmed that a first or changed value is an issuer change. */
  confirmChange: boolean;
  /** The address stack's outputs, undefined when the stack does not exist. */
  addressOutputs: (stackName: string) => Promise<StackOutputs | undefined>;
  /** An upgrade's reader of a deployed stack's parameters, undefined when the stack does not exist. */
  deployedParameters: ((stackName: string) => Promise<Record<string, string> | undefined>) | undefined;
}

/** The PublicApiUrl this deploy gives its stacks, or undefined when nothing sets it (the deployed value is kept or the template's empty default stands). Throws CONFIG_INVALID on a refusal. */
export async function planPublicApiUrl(input: PublicApiUrlPlanInput): Promise<string | undefined> {
  const resolved = await resolveFromAddressStack(input);
  const controlPlane = input.mode === "upgrade" ? await input.deployedParameters?.(environmentStackName(input.env, "control-plane")) : undefined;
  // A running control plane from a release before this setting has no such parameter: it runs with the raw host, an empty value.
  const current = controlPlane === undefined ? undefined : controlPlane[PUBLIC_API_URL_PARAMETER] ?? "";
  if (resolved !== undefined && input.deploySet.has("control-plane")) assertChangeConfirmed(current, resolved, input.confirmChange);
  const effective = resolved ?? (current !== undefined && current !== "" ? current : undefined);
  if (effective !== undefined && effective !== "" && !input.deploySet.has("foundation") && input.mode === "upgrade") await assertFoundationCarries(input, effective);
  return effective;
}

/** The value the address stack's PublicApiOrigin output and the answers allow (contracts resolvePublicApiUrl), or a CONFIG_INVALID refusal naming the stack. */
async function resolveFromAddressStack(input: PublicApiUrlPlanInput): Promise<string | undefined> {
  const addressStack = publicApiAddressStackName(input.env);
  const outputs = await input.addressOutputs(addressStack);
  try {
    return resolvePublicApiUrl({ addressOrigin: outputs === undefined ? undefined : outputs[PUBLIC_API_ORIGIN_OUTPUT] ?? "", proposed: input.proposed, required: input.required });
  } catch (error) {
    throw agentXError("CONFIG_INVALID", `${(error as Error).message} (stack ${addressStack}); nothing was deployed`);
  }
}

function assertChangeConfirmed(current: string | undefined, resolved: string, confirmed: boolean): void {
  const warning = publicApiUrlChangeWarning(current, resolved);
  if (warning !== undefined && !confirmed) throw agentXError("CONFIG_INVALID", `${warning}; nothing was deployed. Run the upgrade again with --confirm-public-api-url-change once Cloud's CodeUrl is ready to move`);
}

/** The foundation is not in this run: its deployed DNS firewall value must already be the one the control plane will use. */
async function assertFoundationCarries(input: PublicApiUrlPlanInput, effective: string): Promise<void> {
  const foundation = await input.deployedParameters?.(environmentStackName(input.env, "foundation"));
  if (foundation !== undefined && (foundation[PUBLIC_API_URL_PARAMETER] ?? "") !== effective) {
    throw agentXError("CONFIG_INVALID", `the foundation's DNS firewall does not allow ${effective}, so workers and the Slack orchestrator could not reach the control plane there; upgrade the foundation in the same run (it takes ${PUBLIC_API_URL_PARAMETER} too); nothing was deployed`);
  }
}

/** The caller's inputs for planPublicApiUrl, from a deploy's own input (deploy-environment.ts keeps its own branches few). */
export function planFromDeploy(input: {
  env: string; mode: "install" | "upgrade"; deploySet: ReadonlySet<DeployPart>; answers: { publicApiUrl?: string; requirePublicApiAddress?: boolean };
  confirmPublicApiUrlChange?: boolean; deployer: { outputs(stackName: string): Promise<StackOutputs | undefined> };
  deployedParameters?: (stackName: string) => Promise<Record<string, string> | undefined>;
}): Promise<string | undefined> {
  return planPublicApiUrl({
    env: input.env, mode: input.mode, deploySet: input.deploySet, proposed: input.answers.publicApiUrl, required: input.answers.requirePublicApiAddress === true,
    confirmChange: input.confirmPublicApiUrlChange === true, addressOutputs: (stackName) => input.deployer.outputs(stackName), deployedParameters: input.deployedParameters,
  });
}

/** The answers with the plan's address (when there is one). */
export function withPublicApiUrl<T extends object>(answers: T, publicApiUrl: string | undefined): T & { publicApiUrl?: string } {
  return publicApiUrl === undefined ? answers : { ...answers, publicApiUrl };
}

/**
 * The foundation's and the control plane's parameters, without PublicApiUrl where this release's template does not declare it (see withDeclaredPublicApiUrl); other parts' untouched.
 * `declaredFor` is asked only when there is a value to place.
 */
export function withDeclaredPublicApiUrlFor(parameters: Record<string, string>, part: DeployPart, declaredFor: (part: DeployPart) => ReadonlySet<string> | undefined): Record<string, string> {
  if (!["foundation", "control-plane"].includes(part) || parameters[PUBLIC_API_URL_PARAMETER] === undefined) return parameters;
  return withDeclaredPublicApiUrl(parameters, declaredFor(part));
}

/** The settings' control plane URL: the permanent address where the install has one, else the API's own endpoint (the caller's required-output reader names a missing one). */
export function controlPlaneUrlOf(outputs: StackOutputs, endpoint: () => string): string {
  return controlPlaneBase(outputs) ?? endpoint();
}

/** The refusal for setting or changing PublicApiUrl on a running stack without the explicit confirm (parameter-update.ts). */
export function assertPublicApiUrlConfirmed(parameters: ReadonlyArray<{ name: string; from: string; to: string }>, confirmed: boolean | undefined): void {
  const change = parameters.find((entry) => entry.name === PUBLIC_API_URL_PARAMETER);
  const warning = change === undefined ? undefined : publicApiUrlChangeWarning(change.from, change.to);
  if (warning !== undefined && confirmed !== true) throw agentXError("CONFIG_INVALID", `${warning}; nothing changed. Confirm it explicitly (--confirm-public-api-url-change)`);
}

/**
 * A stack's parameters with PublicApiUrl taken out where this release's template does not declare it (CloudFormation refuses a parameter its template lacks). A non-empty value the deploy was
 * asked to carry is never dropped silently: that would be the fallback to the raw host this setting exists to prevent.
 */
export function withDeclaredPublicApiUrl(parameters: Record<string, string>, declared: ReadonlySet<string> | undefined): Record<string, string> {
  const value = parameters[PUBLIC_API_URL_PARAMETER];
  if (value === undefined || declared === undefined || declared.has(PUBLIC_API_URL_PARAMETER)) return parameters;
  if (value !== "") throw agentXError("CONFIG_INVALID", `this release's template has no ${PUBLIC_API_URL_PARAMETER} parameter, so it cannot carry the public address ${value}; upgrade to a release that has it`);
  return Object.fromEntries(Object.entries(parameters).filter(([name]) => name !== PUBLIC_API_URL_PARAMETER));
}
