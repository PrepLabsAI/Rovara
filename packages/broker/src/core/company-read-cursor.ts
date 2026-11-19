// The cursor of the company reads (lanes AU and EV): opaque to the caller, and bound to the company and the filters it was made for, so a cursor never opens another company's rows or another question.
// The company's partition is still the only thing ever asked of the store: the position in the cursor is a sort key inside it.
import { createHash } from "node:crypto";
import { agentXError } from "@agentx/contracts";

export const CURSOR_REFUSED = "that cursor is not valid";

/** A short stable digest of the filters a cursor belongs to (names sorted, undefined left out). */
export function filterDigest(filters: Readonly<Record<string, unknown>>): string {
  const text = JSON.stringify(Object.keys(filters).filter((name) => filters[name] !== undefined).sort().map((name) => [name, filters[name]]));
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export function encodeCursor(positionField: "k" | "p", companyId: string, digest: string, position: string): string {
  return Buffer.from(JSON.stringify({ v: 1, c: companyId, h: digest, [positionField]: position })).toString("base64url");
}

/** The position inside a cursor made for this company and these filters, or a refusal with fixed words. */
export function decodeCursor(positionField: "k" | "p", cursor: string, companyId: string, digest: string, validPosition: (position: string) => boolean): string {
  const refused = () => agentXError("CONFIG_INVALID", CURSOR_REFUSED);
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw refused();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw refused();
  const keys = Object.keys(body).sort().join(",");
  if (keys !== ["c", "h", "v", positionField].sort().join(",")) throw refused();
  const { v, c, h } = body as { v: unknown; c: unknown; h: unknown };
  const position = (body as Record<string, unknown>)[positionField];
  if (v !== 1 || c !== companyId || h !== digest || typeof position !== "string" || position.length > 400 || !validPosition(position)) throw refused();
  return position;
}
