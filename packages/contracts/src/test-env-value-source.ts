// Where a proposed test-environment value came from. Split out of test-environment.ts (slice 1 T1) so that both the environment body and the dependency contract (test-env-dependency.ts) can use it without
// importing each other: the body now carries `dependencies`, and the dependency contract already needed this schema. Browser-safe: nothing here imports a Node module.
// `test-environment.ts` re-exports both names, so every existing import keeps working.
import { z } from "zod";
import { SetupValueSourceSchema } from "./setup-run.js";

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;

/**
 * Where a proposed value came from: a file and line, a code detector, the setup agent's own reading, or (setup run, SH2) a command the run observed working (`observed:<run>#<n>`),
 * a company recipe (`recipe:<id>@<rev>`) or a person. Replaces: the three-member union; the new members are additions, so every stored proposal still parses.
 */
export const TestEnvValueSourceSchema = z.union([z.object({ path: z.string().min(1).max(500).regex(NO_HIDDEN, "one plain line"), line: z.number().int().min(1).max(10_000_000) }).strict(), z.literal("model"), z.string().regex(/^detector:[a-z0-9_-]{1,40}$/u), SetupValueSourceSchema]);
export type TestEnvValueSource = z.infer<typeof TestEnvValueSourceSchema>;
