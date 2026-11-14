// The one way an email address is compared and keyed: the verified-email pointer (org.ts orgEmailKey), the sign-in rule that links
// two sign-ins of one person (broker developer/identities.ts) and the invite check all read it. A leaf module, so org.ts and
// developer.ts can both import it without a cycle.

const isAscii = (text: string): boolean => {
  for (const character of text) if (character.codePointAt(0)! >= 0x80) return false;
  return true;
};

/**
 * NFC, trim, then lower-case. `ascii` is true only for an address made of ASCII from the start: Unicode case folding
 * and normalization map some other characters onto ASCII ones (U+212A KELVIN SIGN lower-cases to "k"), so an address
 * that needed either to look ASCII is not trusted to name the same mailbox, and a sign-in never links by it.
 */
export function normalizeEmail(raw: string): { email: string; ascii: boolean } {
  const email = raw.normalize("NFC").trim().toLowerCase();
  return { email, ascii: isAscii(raw.trim()) && isAscii(email) };
}
