import { createHash } from "node:crypto";
import { e2eAgentRouteNeedsModelChoice, type E2EWorkflowAdmissionRef } from "@agentx/contracts";
import { readObjectText } from "../developer/plan-artifacts.js";
import { readAdmittedE2EModelRoute } from "../e2e/model-route-registry.js";

/**
 * How the dispatcher learns what kind of admission a CHECKS reference names: it reads the stored object, holds it to the reference's size and sha256, and answers its
 * `schemaVersion`. Anything it cannot establish (missing, changed, not JSON, no string schemaVersion) answers undefined, which the dispatcher treats as a refusal to deliver.
 */
/**
 * Whether the application admission a reference names has an `agent` step in its scenario bundle, read the same way (held to the reference's size and sha256), and is not an audit
 * replay (Task 4.6b): a replay runs those steps with no model channel, so it never needs the worker to list the agent-steps feature and its reference never carries the flag. Anything it
 * cannot establish answers undefined, which the dispatcher treats as a refusal.
 */
export function createWorkflowE2EAdmissionAgentStepsReader(input: { s3: { send(command: never): Promise<unknown> }; bucket: string }) {
  return async (reference: E2EWorkflowAdmissionRef): Promise<boolean | undefined> => {
    const { key, sha256, byteLength } = reference.admissionRef;
    const text = await readObjectText(input.s3, input.bucket, key, byteLength);
    if (text === undefined) return undefined;
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength !== byteLength || createHash("sha256").update(bytes).digest("hex") !== sha256) return undefined;
    try {
      const parsed = JSON.parse(text) as { bundle?: { scenarios?: unknown }; replay?: unknown } | null;
      const scenarios = parsed?.bundle?.scenarios;
      if (!Array.isArray(scenarios)) return undefined;
      if (parsed?.replay !== undefined) return false;
      return scenarios.some((scenario) => Array.isArray((scenario as { steps?: unknown })?.steps)
        && ((scenario as { steps: Array<{ kind?: unknown }> }).steps).some((step) => step?.kind === "agent"));
    } catch { return undefined; }
  };
}

/**
 * Whether an application admission relies on the normal no-model limits for a group (evaluation fix RUN-1, Ruling DV): its policy pins a route (so its groups with no agent step are
 * capped by `e2eEffectiveRoundLimits`, not given the policy's agent-sized limits) and some scenario has no agent step. Read from the content-addressed object, never from the reference. A
 * baseline's policy pins no route and a routeless policy keeps its stored limits, so neither relies on it. Over-asking is safe (a scenario that shares a group with an agent scenario
 * is counted); the answer is undefined when the object cannot be read as the admission the reference names.
 */
export function createWorkflowE2EAdmissionNeedsModelFreeLimitsReader(input: { s3: { send(command: never): Promise<unknown> }; bucket: string }) {
  return async (reference: E2EWorkflowAdmissionRef): Promise<boolean | undefined> => {
    const { key, sha256, byteLength } = reference.admissionRef;
    const text = await readObjectText(input.s3, input.bucket, key, byteLength);
    if (text === undefined) return undefined;
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength !== byteLength || createHash("sha256").update(bytes).digest("hex") !== sha256) return undefined;
    try {
      const parsed = JSON.parse(text) as { bundle?: { scenarios?: unknown }; policy?: { modelRouteRevision?: unknown } } | null;
      const scenarios = parsed?.bundle?.scenarios;
      if (!Array.isArray(scenarios)) return undefined;
      const routeRevision = parsed?.policy?.modelRouteRevision;
      if (routeRevision === undefined) return undefined;
      if (routeRevision === null) return false;
      return scenarios.some((scenario) => Array.isArray((scenario as { steps?: unknown })?.steps)
        && !((scenario as { steps: Array<{ kind?: unknown }> }).steps).some((step) => step?.kind === "agent"));
    } catch { return undefined; }
  };
}

export function createWorkflowE2EAdmissionSchemaReader(input: { s3: { send(command: never): Promise<unknown> }; bucket: string }) {
  return async (reference: E2EWorkflowAdmissionRef): Promise<string | undefined> => {
    const { key, sha256, byteLength } = reference.admissionRef;
    const text = await readObjectText(input.s3, input.bucket, key, byteLength);
    if (text === undefined) return undefined;
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength !== byteLength || createHash("sha256").update(bytes).digest("hex") !== sha256) return undefined;
    try {
      const schemaVersion = (JSON.parse(text) as { schemaVersion?: unknown } | null)?.schemaVersion;
      return typeof schemaVersion === "string" ? schemaVersion : undefined;
    } catch { return undefined; }
  };
}

/**
 * Whether the route an application admission pins needs a worker that lists the model-choice feature (Task 4.10): the admission is read as the others are (held to the reference's
 * size and sha256), its `modelRoute` names a revision, and the registry's definition of that revision says whether the model is not the recommended one or the request shape is
 * `minimal`. An admission that pins no route (a round with no AI navigation, or a replay) needs nothing. Anything it cannot establish (the object, the registry row, a fault
 * reading it) answers undefined, which the dispatcher treats as a refusal: it never guesses that a route is the default.
 */
export function createWorkflowE2EAdmissionModelChoiceReader(input: {
  s3: { send(command: never): Promise<unknown> };
  bucket: string;
  readRow: (key: { pk: string; sk: string }) => Promise<Record<string, unknown> | undefined>;
}) {
  return async (reference: E2EWorkflowAdmissionRef): Promise<boolean | undefined> => {
    const { key, sha256, byteLength } = reference.admissionRef;
    const text = await readObjectText(input.s3, input.bucket, key, byteLength);
    if (text === undefined) return undefined;
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength !== byteLength || createHash("sha256").update(bytes).digest("hex") !== sha256) return undefined;
    let route: unknown;
    try { route = (JSON.parse(text) as { modelRoute?: unknown } | null)?.modelRoute; } catch { return undefined; }
    if (route === null) return false;
    const named = route as { routeId?: unknown; routeRevision?: unknown } | undefined;
    if (typeof named?.routeId !== "string" || typeof named.routeRevision !== "string") return undefined;
    try {
      const definition = await readAdmittedE2EModelRoute(input.readRow, { routeId: named.routeId, routeRevision: named.routeRevision });
      return definition === null ? undefined : e2eAgentRouteNeedsModelChoice(definition);
    } catch { return undefined; }
  };
}
