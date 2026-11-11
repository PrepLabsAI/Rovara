// Script tokens (UX5b, switch `pt`): a signed-in person makes a token in the app's settings so their own scripts and CI can read and start tasks without a browser
// session. The token acts as its creator, never above the creator's role, only on the projects and with the permissions chosen when it was made. The broker keeps a
// hash of it, never the token; it is shown once. Browser-safe: the web app reads these shapes, and nothing here imports `node:*`.
import { z } from "zod";
import { AGENTX_NAME_PATTERN } from "./names.js";
import { forwardReader } from "./forward-reader.js";

/** Every token starts with this, so a person (and a secret scanner) can tell a Rovara script token from anything else. */
export const SCRIPT_TOKEN_PREFIX = "rvst_";
/** How long a token lives when its creator doesn't choose. */
export const SCRIPT_TOKEN_DEFAULT_DAYS = 30;
/** The longest a token can live: no token is made for longer, and one stored with a longer life is refused at use. */
export const SCRIPT_TOKEN_MAX_DAYS = 90;
/** A person keeps at most this many live tokens (not expired, not revoked) in one company. */
export const SCRIPT_TOKENS_PER_PERSON_MAX = 10;
/** A token names at most this many projects. */
export const SCRIPT_TOKEN_PROJECTS_MAX = 20;
/** A token's name, as its creator typed it. */
export const SCRIPT_TOKEN_NAME_MAX = 60;

/**
 * What a token may do. `read`: read the creator's own tasks on the token's projects (a task, its events, the list). `start`: start a task on one of them.
 * `lessons` (decision 46b): read the project-wide team lessons for a repository of the token's project, for a local coding tool. A token made before it has `read` and `start` only and cannot read lessons.
 * Nothing else is a permission: a token never makes tokens, changes members, roles, billing, company settings or secrets, and never decides anything a person must.
 */
export const SCRIPT_TOKEN_PERMISSIONS = ["read", "start", "lessons"] as const;
export const ScriptTokenPermissionSchema = z.enum(SCRIPT_TOKEN_PERMISSIONS);
export type ScriptTokenPermission = z.infer<typeof ScriptTokenPermissionSchema>;

export const ScriptTokenIdSchema = z.string().regex(/^stk_[0-9a-z]{20}$/);

const unique = (values: readonly string[]) => new Set(values).size === values.length;
const Instant = z.string().datetime();

/** A token's name: one line, no control or invisible-format characters, 1 to `SCRIPT_TOKEN_NAME_MAX` characters once trimmed. */
export const ScriptTokenNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => [...value].length <= SCRIPT_TOKEN_NAME_MAX, `must be at most ${String(SCRIPT_TOKEN_NAME_MAX)} characters`)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "must not contain control characters");

/** `POST /v1/app/script-tokens` (a live browser session only). `days` is the token's life, `SCRIPT_TOKEN_DEFAULT_DAYS` when absent. */
export const CreateScriptTokenBodySchema = z
  .object({
    requestId: z.string().uuid(),
    name: ScriptTokenNameSchema,
    projects: z.array(z.string().regex(AGENTX_NAME_PATTERN)).min(1).max(SCRIPT_TOKEN_PROJECTS_MAX).refine(unique, "must not repeat a project"),
    permissions: z.array(ScriptTokenPermissionSchema).min(1).max(SCRIPT_TOKEN_PERMISSIONS.length).refine(unique, "must not repeat a permission"),
    days: z.number().int().min(1).max(SCRIPT_TOKEN_MAX_DAYS).optional(),
  })
  .strict();
export type CreateScriptTokenBody = z.infer<typeof CreateScriptTokenBodySchema>;

/** Where a token stands by its own record. A token whose creator's role changed or who left is refused at use, whatever this says. */
export const SCRIPT_TOKEN_STATUSES = ["active", "expired", "revoked"] as const;
export const ScriptTokenStatusSchema = z.enum(SCRIPT_TOKEN_STATUSES);

/** One token as the settings screen lists it. `hint` is the token's visible id part (`rvst_…<8 characters>`), never the secret. */
export const ScriptTokenViewSchema = z
  .object({
    tokenId: ScriptTokenIdSchema,
    name: ScriptTokenNameSchema,
    hint: z.string().regex(/^rvst_…[0-9a-z]{8}$/u),
    projects: z.array(z.string().regex(AGENTX_NAME_PATTERN)).max(SCRIPT_TOKEN_PROJECTS_MAX),
    permissions: z.array(ScriptTokenPermissionSchema).max(SCRIPT_TOKEN_PERMISSIONS.length),
    createdAt: Instant,
    expiresAt: Instant,
    lastUsedAt: Instant.optional(),
    revokedAt: Instant.optional(),
    status: ScriptTokenStatusSchema,
    /** True when the viewer made it. An owner or admin also sees the company's other tokens (with `mine: false`) so they can revoke them. */
    mine: z.boolean(),
    /** The creator's name, on another person's token only. */
    createdBy: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ScriptTokenView = z.infer<typeof ScriptTokenViewSchema>;

/** `GET /v1/app/script-tokens`. */
export const ScriptTokenListSchema = z.object({ tokens: z.array(ScriptTokenViewSchema).max(1000) }).strict();
export type ScriptTokenList = z.infer<typeof ScriptTokenListSchema>;

/** `POST /v1/app/script-tokens`: the token itself, this once. The broker never shows it again: a repeat of the request is refused, not answered with it. */
export const CreatedScriptTokenSchema = z.object({ token: ScriptTokenViewSchema, secret: z.string().regex(/^rvst_[0-9a-z]{20}_[0-9a-z]{20}_[A-Za-z0-9_-]{43}$/u) }).strict();
export type CreatedScriptToken = z.infer<typeof CreatedScriptTokenSchema>;

/** `DELETE /v1/app/script-tokens/{id}`. */
export const RevokedScriptTokenSchema = z.object({ token: ScriptTokenViewSchema }).strict();

export const ScriptTokenListReaderSchema = forwardReader(ScriptTokenListSchema);
export const CreatedScriptTokenReaderSchema = forwardReader(CreatedScriptTokenSchema);
export const RevokedScriptTokenReaderSchema = forwardReader(RevokedScriptTokenSchema);
export type ReadScriptTokenView = z.output<typeof ScriptTokenListReaderSchema>["tokens"][number];

/** The refusal when a person already has `SCRIPT_TOKENS_PER_PERSON_MAX` live tokens. */
export const SCRIPT_TOKENS_LIMIT_MESSAGE = `You can have up to ${String(SCRIPT_TOKENS_PER_PERSON_MAX)} script tokens. Revoke one first.`;
/** The refusal for anything a script token may not do. Fixed text: it never names the route, the project or the token. */
export const SCRIPT_TOKEN_NOT_ALLOWED_MESSAGE = "A script token can only read and start tasks on its projects. Use the Rovara app for anything else.";
