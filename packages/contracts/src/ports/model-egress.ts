// The `model-egress` plug-in point (a NEW interface: the owner decides it, Pratik is informed with the next interface batch; DECISIONS 42, 63, 150(b)). TE-F1a, release 0.5.19.
//
// One real model call for a customer's PRODUCT in a test: the worker's bridge hands a checked frame to the adapter and reads back a stream. The adapter holds the keys, the caps and the meter; Code's laptop adapter forwards in
// process with the user's own key, Cloud's adapter invokes the key-holding function. The core owns the pure rules (`model-egress/`: path and header allow lists, credential injection, response scrubbing, usage, classes, cost) so
// every adapter shares one tested core, and every adapter must pass `runModelEgressConformance` (`@agentx/testing`), which includes the two-company kit.
//
// This lives in `ports/` (not `plugins/`): `plugins/` holds the neutral-word ports of outside systems (code host, tracker, check runner); `ports/` holds the core-owned points an install fills with its own adapter (image-registry,
// model-provider, secrets), which is what this is. It is NOT yet listed in `plugin-points.ts`; registering it there is a later step (DEFERRED-CHECKS).
//
// The SCOPE is opaque to Code: it names the company, project, task and source INSIDE the adapter's own capability, and the frame never names any of them. An adapter that cannot resolve a scope answers the one fixed `not_found`;
// "missing" and "another company's" are the same answer.
import type { ModelEgressClass } from "../model-egress/classify.js";
import type { ModelEgressFrame } from "../model-egress/frame.js";
import type { ModelEgressRefusal } from "../model-egress/refusals.js";
import type { ModelEgressScheme } from "../model-egress/schemes.js";

declare const modelEgressScopeBrand: unique symbol;
/** What an adapter hands the core to identify whose call this is: opaque, produced and read only by the adapter. */
export interface ModelEgressScope {
  readonly [modelEgressScopeBrand]: true;
}

export interface ModelEgressCapabilities {
  /** The credential schemes the adapter can place. A row whose scheme is not here is refused `not_allowed`. */
  readonly schemes: readonly ModelEgressScheme[];
}

/** The head of the answer: the status and the allow-listed headers, already sanitised. */
export interface ModelEgressHead {
  readonly kind: "head";
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
}
export interface ModelEgressChunk {
  readonly kind: "chunk";
  readonly bytes: Uint8Array;
}

/** What one call was, as the ledger and the evidence read it. Every number is a whole number. */
export interface ModelEgressSettle {
  readonly kind: "settle";
  readonly status: number;
  readonly class: ModelEgressClass;
  /** The word, when the answer was one of our own refusals. */
  readonly refusal?: ModelEgressRefusal;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Micro-dollars settled on the meter (the reservation when `estimated`). 0 for a refusal that reserved nothing. */
  readonly costMicros: number;
  readonly estimated: boolean;
  /** This call settled above its reservation: the task takes no further call ("budget exceeded by one call"). */
  readonly overrun?: boolean;
}

export type ModelEgressEvent = ModelEgressHead | ModelEgressChunk | ModelEgressSettle;

export interface ModelEgress {
  readonly capabilities: ModelEgressCapabilities;
  /**
   * Forwards one frame and streams the answer: exactly one `head`, then any number of `chunk`s, then exactly one `settle`, always in that order. It never throws for a refusal or a provider fault: a refusal is a head with the
   * refusal's status, the family's error body and `x-rovara-refusal`, then a settle. It makes ONE attempt: no retry after a fault (a retry can double-spend). The adapter checks the frame again with the core's rules; it never
   * trusts the caller's checks.
   */
  forward(scope: ModelEgressScope, frame: ModelEgressFrame, options?: { readonly signal?: AbortSignal }): AsyncIterable<ModelEgressEvent>;
}
