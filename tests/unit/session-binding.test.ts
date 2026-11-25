// Session-id-at-rest: the digest a state row keeps in place of the sign-in session id (the browser's login cookie).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sameSessionBinding, sessionBindingOf } from "../../packages/broker/src/developer/session-binding.js";

describe("sessionBindingOf / sameSessionBinding", () => {
  it("is a full-length lowercase sha256 hex, stable, and not the id, a plain sha256 of it, or the 12-hex log hash's prefix", () => {
    const id = "0b7f3c52-9d61-4c1e-8a3f-5e2d1c9b7a40";
    const digest = sessionBindingOf(id);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(sessionBindingOf(id)).toBe(digest);
    expect(digest).not.toContain(id);
    const plain = createHash("sha256").update(id, "utf8").digest("hex");
    expect(digest).not.toBe(plain);
    expect(digest.startsWith(plain.slice(0, 12))).toBe(false);
    expect(sessionBindingOf(`${id}x`)).not.toBe(digest);
  });
  it("matches only the same session's digest", () => {
    const stored = sessionBindingOf("session-a");
    expect(sameSessionBinding(stored, sessionBindingOf("session-a"))).toBe(true);
    expect(sameSessionBinding(stored, sessionBindingOf("session-b"))).toBe(false);
  });
  it("never matches a raw id, a missing field, a wrong-length or non-string value (an old-shape row fails closed)", () => {
    const presenting = sessionBindingOf("session-a");
    for (const stored of ["session-a", "", undefined, null, 7, presenting.slice(1), presenting.toUpperCase(), `${presenting}0`, { raw: presenting }]) expect(sameSessionBinding(stored, presenting)).toBe(false);
    // A presenting value that is not a digest never matches, even against itself.
    expect(sameSessionBinding("session-a", "session-a")).toBe(false);
  });
});
