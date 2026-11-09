// The words a "model not enabled" refusal ends with, and the edition they depend on. Split out of Cloud's edition module (its feature table and policies stay Cloud-only);
// the behaviour of these three is the same as there. Rovara Code runs with no edition on record, which reads as the neutral sentence.
import { z } from "zod";

export const EditionSchema = z.enum(["enterprise", "public"]);
export type Edition = z.infer<typeof EditionSchema>;

export function editionFromEnvironment(env: { ROVARA_EDITION?: string | undefined } = process.env): Edition | undefined {
  const parsed = EditionSchema.safeParse(env.ROVARA_EDITION);
  return parsed.success ? parsed.data : undefined;
}

/**
 * What the owner is told when a model call was refused because the account behind the route has not enabled the model. An edition that is not known says neither
 * "enable it yourself" nor "Rovara's account".
 */
export function modelNotEnabledSentence(model: string | undefined, edition: Edition | undefined): string {
  const name = model ?? "This model";
  if (edition === "enterprise") return `${name} isn't enabled for your AWS account. Enable it in the Bedrock console, or Rovara will use another model.`;
  if (edition === "public") return `${name} isn't available on Rovara's AI right now; Rovara will use another model.`;
  return `${name} isn't available on the AWS account behind this model route; Rovara will use another model.`;
}
