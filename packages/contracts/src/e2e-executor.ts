import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { E2EApplicationExecutionAdmissionSchema } from "./e2e-application-execution.js";
import { E2EFormLoginSchema } from "./e2e.js";
import { E2E_MODEL_CHANNEL_SCHEMA_VERSION, E2E_MODEL_CHANNEL_SOCKET_PATH } from "./e2e-model-channel.js";

/** The only application an executor run may reach: the candidate app's alias on the per-run internal network. */
export const E2E_EXECUTOR_APP_ORIGIN = "http://app:4317" as const;
/**
 * The origin every compiled suite names. The pinned runner accepts plain HTTP only for loopback hosts, so the executor
 * serves the candidate on this loopback address through a forwarder to `E2E_EXECUTOR_APP_ORIGIN`; the browser, the HTTP
 * client and the assertions all see this one origin.
 */
export const E2E_EXECUTOR_COMPILED_ORIGIN = "http://127.0.0.1:4317" as const;
/** Upper bound for the application health wait, so a hung candidate cannot hold the runner for the whole round. */
export const E2E_EXECUTOR_HEALTH_TIMEOUT_MAX_MS = 120_000;
export const E2E_EXECUTOR_MAX_ACCOUNTS = 16;
/**
 * The seccomp profile the executor container (and only it) runs under: Docker's default profile plus the rules Chromium's own namespace sandbox needs
 * (`unshare` and `clone` with namespace flags, `chroot`), shipped as `packages/verifier/assets/executor-seccomp.json`. The host refuses to start an
 * executor under any other bytes; a test keeps this equal to the shipped file.
 */
export const E2E_EXECUTOR_SECCOMP_PROFILE_SHA256 = "a522ce160601c1b6f703dae74859e995020426454887630f6edec34ffb251f0e";

/** One synthetic account the host seeded into the candidate. The password exists only in the read-only plan mount. */
export const E2EExecutorAccountSchema = z.object({
  profileId: z.string().min(1).max(120),
  email: z.string().min(3).max(256).regex(/^[^\s@]+@[^\s@]+$/),
  password: z.string().min(16).max(256),
  /** Present for a `rovara-form-login/v1` account: the form the executor signs in through. Equal to the login the source contract declares. */
  login: E2EFormLoginSchema.optional(),
}).strict();
export type E2EExecutorAccount = z.infer<typeof E2EExecutorAccountSchema>;

/** The admission is signed by its own digest over every other field; a plan that disagrees is refused. */
export function e2eExecutorAdmissionDigest(admission: z.infer<typeof E2EApplicationExecutionAdmissionSchema>): string {
  const { admissionDigest: _digest, ...body } = admission;
  void _digest;
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

/**
 * What the host mounts read-only into the executor container. The executor decodes the admission, recompiles the
 * group with the same compiler the broker used, and runs exactly that suite against the candidate at `app.origin`.
 */
export const E2EExecutorPlanSchema = z.object({
  schemaVersion: z.literal("e2e-executor-plan/v1"),
  runId: z.string().uuid(),
  groupId: z.string().min(1).max(80),
  admission: E2EApplicationExecutionAdmissionSchema,
  admissionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  app: z.object({
    origin: z.literal(E2E_EXECUTOR_APP_ORIGIN),
    health: z.object({
      path: z.string().min(1).max(512).startsWith("/"),
      expectedStatus: z.number().int().min(100).max(599),
      timeoutMs: z.number().int().positive().max(E2E_EXECUTOR_HEALTH_TIMEOUT_MAX_MS),
    }).strict(),
  }).strict(),
  deadlineAt: z.number().int().positive(),
  accounts: z.array(E2EExecutorAccountSchema).max(E2E_EXECUTOR_MAX_ACCOUNTS),
  /**
   * Present only for a group that has an `agent` step: the worker's model socket, mounted into this executor container alone, and the route it serves. The route must be
   * the one the admission pins. An executor built before this field refuses the plan (the schema is strict), so a mixed fleet fails cleanly.
   */
  modelChannel: z.object({
    protocol: z.literal(E2E_MODEL_CHANNEL_SCHEMA_VERSION),
    socketPath: z.literal(E2E_MODEL_CHANNEL_SOCKET_PATH),
    routeId: z.string().min(1).max(120),
    routeRevision: z.string().min(1).max(120),
  }).strict().optional(),
}).strict().superRefine((plan, context) => {
  if (plan.admission.admissionDigest !== plan.admissionDigest || e2eExecutorAdmissionDigest(plan.admission) !== plan.admissionDigest) {
    context.addIssue({ code: "custom", path: ["admissionDigest"], message: "executor plan admission digest does not bind its admission" });
  }
  if (!plan.admission.groups.some((group) => group.outerBinding.groupId === plan.groupId && group.outerBinding.runId === plan.runId)) {
    context.addIssue({ code: "custom", path: ["groupId"], message: "executor plan group and run are not in its admission" });
  }
  if (plan.modelChannel !== undefined
    && (plan.admission.modelRoute === null || plan.admission.modelRoute.routeId !== plan.modelChannel.routeId || plan.admission.modelRoute.routeRevision !== plan.modelChannel.routeRevision)) {
    context.addIssue({ code: "custom", path: ["modelChannel"], message: "executor plan model channel is not the route its admission pins" });
  }
  if (new Set(plan.accounts.map((account) => account.profileId)).size !== plan.accounts.length) {
    context.addIssue({ code: "custom", path: ["accounts"], message: "executor plan accounts must have unique profiles" });
  }
});
export type E2EExecutorPlan = z.infer<typeof E2EExecutorPlanSchema>;
