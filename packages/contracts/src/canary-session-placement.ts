/**
 * CANARY-SESSION (arch ruling 2026-11-25): the four stack parameters of the beta canary's session function are PLACEMENT configuration, not a rollout flag and not a customer setting. They say WHICH
 * account holds the fixture function and who it may mint a session for; the function exists only while all four are given with the environment `beta`. Each row below is what F1's install layer
 * carries for a parameter (install layer, operator-only, not customer-facing, "beta only"), so a generated parameter list, the upgrade carry rule and the docs all
 * read ONE place; infra/lib/canary-session.ts declares its parameters from these rows.
 *
 * F1 has landed: each parameter also has an install row in packages/contracts/src/settings/install-rows.ts (part control-plane, declaredIn legacy, class operator, empty default, carried by nothing: an upgrade never names it).
 * Those rows read their pattern and words from THESE rows, which keep what the install rows have no field for (`class: "placement"`, what could derive the value, why it is a parameter anyway).
 */

/** The only stage the function may exist in. */
export const CANARY_SESSION_PLACEMENT_STAGE = "beta";
/**
 * The canary stack's step role is named `<canary stack name>-step-role`, and the beta canary stack's name ends `-beta-canary`: so the role's name ends `-beta-canary-step-role`. Only that ending is written here
 * (the stack's full name belongs to the other repository: this public file never repeats it); a role of production's canary or of another environment cannot match. The role's account is the beta account.
 */
export const CANARY_SESSION_STEP_ROLE_SUFFIX = "-beta-canary-step-role";

export type CanarySessionDerivable = "no" | "partly" | "yes";

export interface PlacementRow {
  /** The CloudFormation parameter of the control plane (the legacy layout only). */
  readonly parameter: string;
  readonly part: "control-plane";
  readonly layer: "install";
  readonly class: "placement";
  readonly audience: "operator";
  readonly customerFacing: false;
  readonly availability: "beta only";
  /**
   * An upgrade keeps the deployed value: the legacy deployment's release (`cdk deploy`) keeps every parameter it is not given, and refuses to send these (scripts/release-production.ts). The CLI's
   * OPERATOR_PARAMETERS is for named environments, whose templates never declare them, so they are not listed there. Production's value is always empty.
   */
  readonly carriedOnUpgrade: true;
  /** Whether the value could be read from something the stack already has, and why it is a parameter anyway. */
  readonly derivable: CanarySessionDerivable;
  readonly derivation: string;
  /** The CloudFormation AllowedPattern: empty, or the one shape the value may have. */
  readonly pattern: string;
  readonly description: string;
}

const row = (input: Pick<PlacementRow, "parameter" | "derivable" | "derivation" | "pattern" | "description">): PlacementRow =>
  ({ part: "control-plane", layer: "install", class: "placement", audience: "operator", customerFacing: false, availability: "beta only", carriedOnUpgrade: true, ...input });

export const CANARY_SESSION_PLACEMENT_ROWS: readonly PlacementRow[] = [
  row({
    parameter: "CanarySessionPlacementEnvironment", derivable: "no", derivation: "the gate itself: nothing in the stack says which account is beta",
    pattern: `^(${CANARY_SESSION_PLACEMENT_STAGE})?$`,
    description: "Places the canary session function: `beta` builds it, empty builds nothing. Any other value is refused. Production's deploy never sets it, and its release refuses a stack that has it",
  }),
  row({
    parameter: "CanarySessionPerson", derivable: "no", derivation: "the person exists only after the owner's real GitHub sign-in; nothing in the stack knows their id",
    pattern: "^([a-f0-9]{64})?$",
    description: "The one person the canary session function may mint a session for: their developer id (64 hex), from the owner's real GitHub sign-in",
  }),
  row({
    parameter: "CanarySessionCompany", derivable: "partly",
    derivation: "the function could read the person's company from their membership row at run time; it is a parameter so that the function and its table grants name ONE company with no real data, and refuse any other",
    pattern: "^(org_[0-9a-z]{20})?$",
    description: "The one company (org_ and 20 letters or digits) the canary session function mints into: the canary company, with no real data",
  }),
  row({
    parameter: "CanarySessionStepRoleName", derivable: "partly",
    derivation: `the name is fixed by the Cloud canary stack, and the function builds the role's ARN itself with THIS stack's own account, so no other account's role can be typed in; it stays a parameter because the role lives in that other stack, and its pattern pins the name's ending (${CANARY_SESSION_STEP_ROLE_SUFFIX})`,
    pattern: `^([a-z0-9]+(-[a-z0-9]+)*${CANARY_SESSION_STEP_ROLE_SUFFIX})?$`,
    description: "The NAME (not the ARN) of the canary stack's step role: the only principal the function's resource policy lets invoke it, in this stack's own account",
  }),
];

export const CANARY_SESSION_PLACEMENT_PARAMETERS: readonly string[] = CANARY_SESSION_PLACEMENT_ROWS.map((entry) => entry.parameter);
/** The parameter that decides: production's release refuses a control plane that holds it non-empty. */
export const CANARY_SESSION_PLACEMENT_ENVIRONMENT_PARAMETER = "CanarySessionPlacementEnvironment";
