// Spec 062 Phase 7c3b (FR-080): forms the core asks an adapter to show when a person presses a button, and what comes
// back when they submit one. A form has read-only parts and fields; `state` is the core's own, given back untouched on
// submission. The adapter answers a press within its surface's limit (Slack: three seconds), so the core answers
// a press synchronously with the form to open.
import { z } from "zod";

const PlainText = z.string().min(1).max(3_000);
/** A field's or a part's ID: what a submission's values and errors are keyed by. */
export const FormPartIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/);

export const ChannelFormOptionSchema = z.object({
  label: z.string().min(1).max(150),
  /** The label is written in the surface's markup (Slack's mrkdwn), not plain text. */
  markup: z.boolean().optional(),
  value: z.string().min(1).max(150),
  description: z.string().min(1).max(150).optional(),
  descriptionMarkup: z.boolean().optional(),
}).strict();
export type ChannelFormOption = z.infer<typeof ChannelFormOptionSchema>;

export const ChannelFormFieldKindSchema = z.enum(["text", "multiline", "select", "multiselect", "checkboxes", "radio", "person"]);
export type ChannelFormFieldKind = z.infer<typeof ChannelFormFieldKindSchema>;

export const ChannelFormPartSchema = z.discriminatedUnion("type", [
  /** `literal`: the text is shown as written, with no links or names made from it (Slack's verbatim). */
  z.object({ type: z.literal("section"), id: FormPartIdSchema.optional(), text: PlainText, literal: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("context"), id: FormPartIdSchema.optional(), text: PlainText, literal: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("divider"), id: FormPartIdSchema.optional() }).strict(),
  z.object({
    type: z.literal("field"),
    id: FormPartIdSchema,
    /** The input's own ID within the field, which a submission's value names too. */
    inputId: FormPartIdSchema,
    kind: ChannelFormFieldKindSchema,
    label: z.string().min(1).max(2_000),
    optional: z.boolean().optional(),
    hint: z.string().min(1).max(2_000).optional(),
    placeholder: z.string().min(1).max(150).optional(),
    initial: z.string().max(3_000).optional(),
    initialValues: z.array(z.string().max(150)).max(100).optional(),
    maxLength: z.number().int().min(1).max(3_000).optional(),
    options: z.array(ChannelFormOptionSchema).min(1).max(100).optional(),
  }).strict(),
]);
export type ChannelFormPart = z.infer<typeof ChannelFormPartSchema>;

export const ChannelFormSchema = z.object({
  /** Names the form a submission comes from; a form only to read has none. */
  formId: z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/).optional(),
  title: z.string().min(1).max(24),
  submitLabel: z.string().min(1).max(24).optional(),
  closeLabel: z.string().min(1).max(24).optional(),
  /** The core's own state, given back untouched with a submission. */
  state: z.string().max(3_000).optional(),
  parts: z.array(ChannelFormPartSchema).max(100),
}).strict();
export type ChannelForm = z.infer<typeof ChannelFormSchema>;

/** One field's submitted value: text or one choice in `value`, several choices in `values`, a person's ID in `value`. */
export const ChannelFormValueSchema = z.object({
  kind: ChannelFormFieldKindSchema,
  value: z.string().max(3_000).optional(),
  values: z.array(z.string().max(150)).max(100).optional(),
}).strict();
export type ChannelFormValue = z.infer<typeof ChannelFormValueSchema>;

/**
 * A submitted form: the form as shown (its parts, so the core can name its fields), the core's state, and each
 * field's value keyed by field and input ID. `handle` is the surface's own ID for the open form, for a later update.
 */
export const ChannelFormSubmissionSchema = z.object({
  form: ChannelFormSchema,
  handle: z.string().min(1).max(255).optional(),
  values: z.record(FormPartIdSchema, z.record(FormPartIdSchema, ChannelFormValueSchema)).refine((values) => Object.keys(values).length <= 100, "at most 100 fields"),
}).strict();
export type ChannelFormSubmission = z.infer<typeof ChannelFormSubmissionSchema>;

/**
 * The core's synchronous answer to a press or a submission (FR-080). `open` is a form to open now. For a submission,
 * `form` closes it, shows errors on its fields, or replaces it.
 */
export const ChannelActionAnswerSchema = z.object({
  status: z.literal("handled"),
  open: ChannelFormSchema.optional(),
  form: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("close") }).strict(),
    z.object({ kind: z.literal("errors"), errors: z.record(FormPartIdSchema, z.string().min(1).max(500)) }).strict(),
    z.object({ kind: z.literal("update"), form: ChannelFormSchema }).strict(),
  ]).optional(),
}).strict();
export type ChannelActionAnswer = z.infer<typeof ChannelActionAnswerSchema>;
