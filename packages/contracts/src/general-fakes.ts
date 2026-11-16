// General fakes, slice 1 (owner decision 234 item 1; plan lanes TE-G1, TE-G2, TE-G6): when a customer's test calls an outside service the check round cannot reach and the customer has no fake of their own,
// Rovara makes one from the customer's OpenAPI description (openapi-fake.ts) and answers the test's calls with it. Every answer is "Made by Rovara" and NEVER counts as change proof; a call the fake cannot
// answer makes the check "Not run" with one of the fixed reasons below, never "failed".
//
// What lives here: the project setting (`generalFakes`, absent = off), the CHECKS payload the broker sends to a worker that lists GENERAL_FAKES_FEATURE, and the fixed words. All text is fixed: no path, service,
// variable, host or body is ever echoed into a reason or a label.
import { z } from "zod";
import { EVIDENCE_TRUST_CLASS_WORDS } from "./check-kinds.js";
import { MODEL_REDIRECT_ENV_NAMES } from "./model-catalog.js";

/** Sent only to a worker whose /ping lists it; an earlier worker's strict payload schema does not know the field. */
export const GENERAL_FAKES_FEATURE = "task.generalFakes.v1" as const;
export const GENERAL_FAKES_MAX_SERVICES = 8;

/** Variables a fake's base URL may never replace: the process's own plumbing and proxies. */
/** Also: shell start-up files, git, TLS trust, the worker's own variables, and every variable the model helper points at itself (a fake must never take a model client's traffic). */
const RESERVED_VARIABLE = /^(?:PATH|HOME|SHELL|USER|LOGNAME|PWD|TMPDIR|TEMP|TMP|LANG|TERM|NODE_OPTIONS|NODE_PATH|NODE_ENV|NODE_EXTRA_CA_CERTS|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|RUBYOPT|PERL5OPT|JAVA_TOOL_OPTIONS|BASH_ENV|ENV|PROMPT_COMMAND|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|GIT_[A-Z0-9_]*|AGENTX_[A-Z0-9_]*|ROVARA_[A-Z0-9_]*|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|CI)$/u;
const MODEL_VARIABLES: ReadonlySet<string> = new Set(MODEL_REDIRECT_ENV_NAMES);
const VariableSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u).refine((name) => !RESERVED_VARIABLE.test(name) && !MODEL_VARIABLES.has(name), "reserved variable");
/** A file under the workspace: relative, plain characters, and no segment that starts with a dot (no `..`, and never the worker's own `.agentx` state). */
const SpecPathSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,31}$/u).refine((path) => !path.split("/").some((part) => part.startsWith(".")), "relative path");

export const GeneralFakeServiceSchema = z.object({
  /** The base-URL variable the customer's code reads for this service (`PAYMENTS_API_URL`). The round sets it to the fake. */
  variable: VariableSchema,
  /** The service's OpenAPI description, relative to the workspace. Absent: the one OpenAPI 3 file found in the repositories. */
  spec: SpecPathSchema.optional(),
}).strict();
export type GeneralFakeService = z.infer<typeof GeneralFakeServiceSchema>;
const ServicesSchema = z.array(GeneralFakeServiceSchema).max(GENERAL_FAKES_MAX_SERVICES)
  .refine((services) => new Set(services.map((service) => service.variable)).size === services.length, "each variable once");

/** The project setting. Absent or `enabled: false`: off, and every run is exactly as it was before this setting existed. */
export const GeneralFakesSettingSchema = z.object({ enabled: z.boolean(), services: ServicesSchema }).strict();
export type GeneralFakesSetting = z.infer<typeof GeneralFakesSettingSchema>;

/** The CHECKS payload field: only the services, only when the setting is on with at least one. */
export const GeneralFakesPayloadSchema = z.object({ services: ServicesSchema.refine((services) => services.length > 0, "at least one service") }).strict();
export type GeneralFakesPayload = z.infer<typeof GeneralFakesPayloadSchema>;

/** The payload for a stored setting, or undefined (off). A setting that no longer parses is off: fakes are never turned on by a damaged record. */
export function generalFakesPayloadOf(setting: unknown): GeneralFakesPayload | undefined {
  if (setting === undefined) return undefined;
  const parsed = GeneralFakesSettingSchema.safeParse(setting);
  if (!parsed.success || !parsed.data.enabled || parsed.data.services.length === 0) return undefined;
  return { services: parsed.data.services.map((service) => ({ ...service })) };
}

/** Why a fake could not answer a call. The first three mean no fake was built for the service; the last two are about one call. */
export const GENERAL_FAKE_REASONS = ["no_spec", "spec_unreadable", "spec_ambiguous", "operation_unsupported", "operation_unknown", "start_failed"] as const;
export type GeneralFakeReason = (typeof GENERAL_FAKE_REASONS)[number];

/** "Not run" with the reason, in fixed words. A check that failed after a call its fake could not answer reads this, never "failed". */
export const GENERAL_FAKE_NOT_RUN_SENTENCES: Readonly<Record<GeneralFakeReason, string>> = Object.freeze({
  no_spec: "Not run: this test calls an outside service, and no OpenAPI description was found to make a fake from.",
  spec_unreadable: "Not run: this test calls an outside service whose OpenAPI description could not be read.",
  spec_ambiguous: "Not run: this test calls an outside service, and more than one OpenAPI description was found; name one in the project setting.",
  operation_unsupported: "Not run: this test called an operation whose answer uses OpenAPI parts Rovara cannot fake yet.",
  operation_unknown: "Not run: this test called an operation the service's OpenAPI description does not list.",
  start_failed: "Not run: Rovara could not start its fakes for this round.",
});

/** The trust class and its words: shared with the evidence vocabulary (check-kinds.ts), never a second spelling. */
export const GENERAL_FAKE_TRUST = "made_by_rovara" as const;
export const GENERAL_FAKE_LABEL = EVIDENCE_TRUST_CLASS_WORDS[GENERAL_FAKE_TRUST];
/** Said beside any check a Rovara-made fake answered, wherever it is reported as passed or failed (slice 2). Fixed words only: the shared label and the never-proof rule. */
export const GENERAL_FAKE_MADE_NOTE = `${GENERAL_FAKE_LABEL}, never change proof`;
/** The setting is on but the checks run in a task sandbox or dev container: slice 1 serves fakes only on the local shell. Checks run exactly as without the setting. */
export const GENERAL_FAKES_LOCAL_ONLY_SENTENCE = "Rovara-made fakes were not used: for now they run only when checks run on this machine's local shell.";

/** The round's line: how many calls a Rovara-made fake answered. Fixed words and a number only. */
export function generalFakesRoundLine(served: number): string {
  const count = Number.isSafeInteger(served) && served > 0 ? served : 0;
  return `${GENERAL_FAKE_LABEL}: ${String(count)} outside ${count === 1 ? "call" : "calls"} in this check round ${count === 1 ? "was" : "were"} answered by fakes Rovara made from your OpenAPI description. They never count as change proof.`;
}
