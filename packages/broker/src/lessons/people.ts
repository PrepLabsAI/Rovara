// Who a lesson may name: the display name of a person who is, or was, one of this install's people, and whether they have been erased. A person who was erased, or whose record cannot be read, is
// "a former member". The name is cut down to the characters a pull request description and a git trailer carry without any markup, mention or second line.
import { ATTRIBUTION_NAME_MAX, containsEmailAddress } from "@agentx/contracts";

export interface AttributionReader {
  /** The display name of a person who is, or was, one of this install's people. Undefined for someone who never was. Throws when it cannot tell. */
  memberName(orgId: string, developerId: string): Promise<string | undefined>;
  /** Whether the person has been erased. Throws when it cannot tell. */
  isErased(orgId: string, developerId: string): Promise<boolean>;
}

/** A display name cut to what a description can carry: letters, marks, digits, spaces and . , ' - . A name that holds an e-mail address, or nothing, is "Member". */
export function attributionNameOf(displayName: string): string {
  if (containsEmailAddress(displayName)) return "Member";
  const plain = displayName.normalize("NFC").replace(/[^\p{L}\p{M}\p{N} .,'’-]/gu, "").replace(/ {2,}/gu, " ").trim().replace(/^[^\p{L}\p{M}\p{N}]+/u, "");
  const cut = Array.from(plain).slice(0, ATTRIBUTION_NAME_MAX).join("").trim();
  const ended = cut.replace(/[^\p{L}\p{M}\p{N}.]+$/u, "");
  return ended === "" ? "Member" : ended;
}
