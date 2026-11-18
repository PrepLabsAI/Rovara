// L4-EVS (DEC 254zzz20 D3): the environment the sealed eval runs in. Until now the fresh eval sandbox ran the worker's bare image over a checkout of one commit: no saved
// environment, no install, so an eval that imports any third-party package failed at its first import. The broker now MAY deliver, beside the trusted eval plan, one of:
//   saved    the project's saved environment image (by digest) with a short-lived pull login for that one repository. The worker pulls it, extracts the seed WITHOUT running anything
//            in it, and puts only its dependency folders (`node_modules`, `.venv`, ...) next to the commit's own files. Never a tracked file of the image: the commit's code is the code.
//   install  the project's approved setup install commands, run once in the same checkout BEFORE the sealed run, in a box with no model route and no bridge, whose only egress is the
//            install phase's package-registry reach (the machine's own allowed-websites mechanism). Then the box is sealed: no network except the model helper.
// Absent: today's bare image. The login rides this answer only (the answer is never stored or logged) and the worker uses it once, in memory.
import { z } from "zod";
import { ImageDigestSchema } from "./saved-env.js";
import { SavedEnvRegistryAuthSchema, isSavedEnvRepositoryName } from "./saved-env-image.js";

/** At most this many install commands (a project's approved setup is a short list). */
export const EVAL_INSTALL_COMMANDS_MAX = 8;
/** The longest one install step may run, in milliseconds. */
export const EVAL_INSTALL_STEP_MAX_MS = 20 * 60_000;

const executable = z.string().regex(/^[A-Za-z0-9._/+-]{1,256}$/u);
const plainArg = z.string().max(8192).refine(arg => !/[\0\r\n]/u.test(arg), "a plain argument");
const relativeDirectory = z.string().regex(/^(?:\.|[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+){0,31})$/u).refine(path => !path.split("/").includes(".."), "inside the checkout");

/** One approved setup install step: an argv (no shell), run in `cwd` (relative to the checkout). */
export const EvalInstallCommandSchema = z.object({ executable, args: z.array(plainArg).max(256), cwd: relativeDirectory }).strict();
export type EvalInstallCommand = z.infer<typeof EvalInstallCommandSchema>;

export const EvalEnvironmentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("saved"),
    repository: z.string().refine(isSavedEnvRepositoryName, "a saved environment repository name"),
    digest: ImageDigestSchema,
    environmentKey: z.string().regex(/^[a-f0-9]{64}$/u),
    testEnvRevision: z.number().int().min(1),
    /** The repository's folder inside the image's seed (the project's repository path). */
    directory: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,3}$/u),
    /** A pull login for that one repository, short-lived. Used once, in memory; never stored, logged or shown. */
    login: SavedEnvRegistryAuthSchema,
    /** When the project also has approved install commands, they run if the saved image cannot be used (never both). */
    fallbackInstall: z.array(EvalInstallCommandSchema).max(EVAL_INSTALL_COMMANDS_MAX).optional(),
  }).strict().refine(env => env.login.repository === env.repository, "the login is for another repository"),
  z.object({ kind: z.literal("install"), commands: z.array(EvalInstallCommandSchema).min(1).max(EVAL_INSTALL_COMMANDS_MAX) }).strict(),
]);
export type EvalEnvironment = z.infer<typeof EvalEnvironmentSchema>;
