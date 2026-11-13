// A short reference for a log line. The line names the company and the id only as a 12-hex hash, so a log never carries a raw id and two lines about the same task still match.
import { createHash } from "node:crypto";

/** A 12-hex hash of the parts (never reversible from a log line). */
export const logRef = (...parts: readonly string[]): string => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 12);
