// A tampered repository grant, the same way every time: one character in the MIDDLE of the signature is replaced by another base64url character, so the signature's decoded bytes really change.
// (Replacing the LAST character is not a tamper one time in sixteen: its 2 low bits are unused, so "w", "x", "y" and "z" decode alike.)
export function tamperedGrant(grant: string): string {
  const [payload, signature] = grant.split(".") as [string, string];
  const at = Math.floor(signature.length / 2);
  return `${payload}.${signature.slice(0, at)}${signature[at] === "A" ? "B" : "A"}${signature.slice(at + 1)}`;
}

/** The other spellings of a grant's signature that a decoder which ignores the unused bits of the last character reads as the same bytes (three, each differing from the issued one). */
export function siblingSpellings(grant: string): string[] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const [payload, signature] = grant.split(".") as [string, string];
  const last = alphabet.indexOf(signature.at(-1)!);
  return [0, 1, 2, 3].map((low) => alphabet[(last & 0b111100) | low]!).filter((char) => char !== signature.at(-1)).map((char) => `${payload}.${signature.slice(0, -1)}${char}`);
}
