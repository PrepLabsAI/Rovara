import { redactText } from "@agentx/contracts";

/** A person's name as it reads inside a sentence: one line, redacted, cut short. (Moved here from the old task page module, which D1 deleted.) */
export function plainName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const characters = Array.from(redactText(name).replace(/[\p{Cc}\s]+/gu, " ").trim());
  if (characters.length === 0) return undefined;
  return characters.length <= 80 ? characters.join("") : `${characters.slice(0, 79).join("")}…`;
}
