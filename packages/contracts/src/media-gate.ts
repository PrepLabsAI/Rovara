// Proof and evidence B4: the gate in front of video and traces (design 3.4). A trace or a video of a browser session can hold session tokens, cookies and anything on screen, and scrubbing cannot be made
// reliable, so they are kept only when the secrets in them are worthless: the accounts are run-scoped (made for the round and revoked after it), the data is synthetic, the tier lets the provisioner delete,
// and the company has switched the less-safe option on. Every condition must hold; the first one that does not names the reason, in the design's order. Pure and browser-safe.
//
// Two checkpoints use it (`evaluateMediaGate` and `evaluatePublicationGate`). At ADMISSION the broker asks `evaluateMediaGate` and sets the capture policy's `video` and `traces` from the answer (so an executor is never asked to record what may not be kept).
// At PUBLICATION the evidence pack asks again with the revocation proof (`revocationConfirmed`), and a file whose gate is not whole is deleted, not just hidden.
import { provisionerIsRunScoped, type TestEnvAccount } from "./test-environment.js";
import type { EVIDENCE_WITHHELD_REASONS } from "./evidence.js";

export type MediaKind = "video" | "trace";
export type MediaWithheldReason = Extract<(typeof EVIDENCE_WITHHELD_REASONS)[number], "account_not_run_scoped" | "tier_not_allowed" | "data_not_synthetic" | "company_setting_off" | "revocation_not_confirmed">;

export interface MediaGateInput {
  /** What the approved environment asks to capture. */
  capture: { video: boolean; traces: boolean };
  tier: "sandbox" | "preview" | "shared";
  /** The approved environment's accounts, by provisioner. */
  accounts: ReadonlyArray<Pick<TestEnvAccount, "provisioner" | "profileId">>;
  /** The run's data, as the data guard reports it. Anything but "synthetic" refuses. */
  data: "synthetic" | "unknown" | "real";
  /** The company's less-safe settings (a second person, a fresh sign-in), per kind. */
  companyAllows: { video: boolean; trace: boolean };
  /** Only at publication: the broker's own proof that the accounts were revoked, their sessions ended and replayed credentials refused. Absent at admission (not known yet); `evaluatePublicationGate` requires `true`. */
  revocationConfirmed?: boolean | undefined;
}

export interface MediaGateResult {
  /** Per kind: may it be captured (admission) or kept (publication). */
  allowed: Record<MediaKind, boolean>;
  /** The reason a kind that was asked for is refused: the first failing condition. */
  reasons: Partial<Record<MediaKind, MediaWithheldReason>>;
  /** The tier rule on its own. */
  tierAllowed: boolean;
}

/**
 * Tier rule (Opus review I1). Video and traces are kept ONLY where the app and its data are the round's own and die with it: tier 1 (sandbox) and tier 2 (a per-task preview environment). A shared
 * pre-prod environment (tier 3) is refused whatever its accounts: a trace keeps every response body and the on-screen text, which there include other users' records, admin pages, third-party keys in
 * bundles and internal hostnames, none of which revocation neutralises, and until the data guard (E10) MEASURES synthetic data the "synthetic" input is only the environment's own declaration.
 * OWNER-VISIBLE DEFAULT: media is off in tier 3 for now. Turning it on needs E10's measured data check plus a per-environment secret list registered with the redactor, and a decision recorded in DECISIONS.md.
 */
export function mediaTierAllowed(tier: MediaGateInput["tier"]): boolean {
  return tier === "sandbox" || tier === "preview";
}

export function evaluateMediaGate(input: MediaGateInput): MediaGateResult {
  const runScoped = input.accounts.length > 0 && input.accounts.every((account) => provisionerIsRunScoped(account.provisioner));
  const tierAllowed = mediaTierAllowed(input.tier);
  const allowed: Record<MediaKind, boolean> = { video: false, trace: false };
  const reasons: MediaGateResult["reasons"] = {};
  for (const kind of ["video", "trace"] as const) {
    const asked = kind === "video" ? input.capture.video : input.capture.traces;
    if (!asked) continue;
    // The first failing condition names the reason, in the design's order.
    const reason: MediaWithheldReason | undefined = !runScoped ? "account_not_run_scoped"
      : !tierAllowed ? "tier_not_allowed"
        : input.data !== "synthetic" ? "data_not_synthetic"
          : !input.companyAllows[kind] ? "company_setting_off"
            : input.revocationConfirmed === false ? "revocation_not_confirmed"
              : undefined;
    if (reason === undefined) allowed[kind] = true; else reasons[kind] = reason;
  }
  return { allowed, reasons, tierAllowed };
}

/**
 * The gate at PUBLICATION (Opus review I2): the same conditions as admission, re-applied in full (accounts, tier, the data check, the company setting), and the revocation proof must be exactly `true`.
 * Anything else, an `undefined` from a caller that forgot it included, is "revocation_not_confirmed". Admission may leave the proof open because it is not known yet; publication may not.
 */
export function evaluatePublicationGate(input: Omit<MediaGateInput, "revocationConfirmed"> & { revocationConfirmed: boolean | undefined }): MediaGateResult {
  return evaluateMediaGate({ ...input, revocationConfirmed: input.revocationConfirmed === true });
}
