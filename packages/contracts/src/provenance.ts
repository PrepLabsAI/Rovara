// Meta repo lane A (K1): where a value came from.
// Two small contracts that every later lane builds on, with no Node dependency (the proposal page in the UI uses them too):
//   1. `SettingOrigin`: who last set a project setting (`person`, `agent`, `file`). A value a person typed is never replaced by an agent's or a
//      file's value unless that person says so for that one value.
//   2. `Provenance` and `Proposed<T>`: the citation each item of a setup proposal must carry, and the wrapper that attaches it.
import { z } from "zod";
import { AgentXNameSchema } from "./names.js";
import { RelativeWorkspacePathSchema } from "./project.js";

/** Who last set a project setting. Absent means `person`: a project that predates origins was typed by a person, so nothing replaces it silently. */
export const SETTING_ORIGINS = ["person", "agent", "file"] as const;
export const SettingOriginSchema = z.enum(SETTING_ORIGINS);
export type SettingOrigin = z.infer<typeof SettingOriginSchema>;

/** Control, format and line-separator characters: nothing a person reads, and a way to hide text from them. */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** Text with every hidden character removed. */
export function withoutHiddenCharacters(text: string): string {
  return text.replace(HIDDEN_CHARACTERS, "");
}

export const PROVENANCE_KINDS = ["file", "ci", "readme", "manifest", "connector", "inferred", "person"] as const;
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

/** The kinds that name a place in a repository's files; the broker re-reads that place to check the citation. */
export const FILE_PROVENANCE_KINDS: readonly ProvenanceKind[] = ["file", "ci", "readme", "manifest"];

export const PROVENANCE_QUOTE_MAX = 200;
export const PROVENANCE_NOTE_MAX = 500;
export const PROVENANCE_PER_ITEM_MAX = 8;

const CommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, "commit must be a full 40 or 64 character hash");

/** A quote or note: hidden characters removed first, then the length is checked on what a person would read. */
const cleanText = (max: number) => z.string().max(max * 5).transform(withoutHiddenCharacters).pipe(z.string().trim().min(1).max(max));

/**
 * One place a proposed value came from. A file citation names the repository, the commit and the path (and usually a line and a short quote), so the
 * broker can re-read `repo@commit:path` and confirm the quote is there. An `inferred` or `connector` citation has no place to re-read, so it must say
 * in `note` what the value was concluded from.
 */
export const ProvenanceSchema = z.object({
  kind: z.enum(PROVENANCE_KINDS),
  repo: AgentXNameSchema.optional(),
  commit: CommitSchema.optional(),
  path: RelativeWorkspacePathSchema.optional(),
  line: z.number().int().positive().max(10_000_000).optional(),
  quote: cleanText(PROVENANCE_QUOTE_MAX).optional(),
  note: cleanText(PROVENANCE_NOTE_MAX).optional(),
}).strict().superRefine((value, context) => {
  if (FILE_PROVENANCE_KINDS.includes(value.kind)) {
    for (const field of ["repo", "commit", "path"] as const) {
      if (value[field] === undefined) context.addIssue({ code: "custom", path: [field], message: `a ${value.kind} citation names ${field}` });
    }
  } else if (value.kind === "inferred" || value.kind === "connector") {
    if (value.note === undefined) context.addIssue({ code: "custom", path: ["note"], message: `a ${value.kind} citation says in note what it was concluded from` });
  }
  if (value.line !== undefined && value.path === undefined) context.addIssue({ code: "custom", path: ["line"], message: "a line needs a path" });
  if (value.quote !== undefined && value.path === undefined) context.addIssue({ code: "custom", path: ["quote"], message: "a quote needs a path" });
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const PROPOSAL_CONFIDENCE = ["high", "medium", "low"] as const;
export const ProposalConfidenceSchema = z.enum(PROPOSAL_CONFIDENCE);

/**
 * How much a person's say matters for applying one proposed item:
 * `safe` a maintainer may apply it; `needs_admin` an admin (and a fresh sign-in) must; `needs_second_person` a second person must also approve;
 * `flagged` it is shown and never proposed as a value (for example a `curl ... | sh` line).
 */
export const PROPOSAL_RISKS = ["safe", "needs_admin", "needs_second_person", "flagged"] as const;
export const ProposalRiskSchema = z.enum(PROPOSAL_RISKS);
export type ProposalRisk = z.infer<typeof ProposalRiskSchema>;

/**
 * `Proposed<T>`: a value with the places it came from. At least one citation is required (the broker drops an item without one), so a model cannot
 * propose a value from nowhere.
 */
export function proposedSchema<Value extends z.ZodType>(value: Value) {
  return z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "id must be 1 to 64 lowercase letters, digits, dots, dashes or underscores"),
    value,
    from: z.array(ProvenanceSchema).min(1).max(PROVENANCE_PER_ITEM_MAX),
    confidence: ProposalConfidenceSchema,
    risk: ProposalRiskSchema,
  }).strict();
}
export type Proposed<Value> = {
  id: string;
  value: Value;
  from: Provenance[];
  confidence: z.infer<typeof ProposalConfidenceSchema>;
  risk: ProposalRisk;
};
