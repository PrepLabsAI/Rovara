// Pins, as literals, the setup sentences an outside client exact-matches or mirrors and that the owner's "address" wording decision
// changed. A test that imports the constant cannot catch a wording slip; a client's frozen list can.
import { describe, expect, it } from "vitest";
import { SETUP_HOST_NEEDS_ADMIN, SETUP_NEEDS_ADMIN } from "../../packages/broker/src/core-host/setup-approval.js";
import { SETUP_NO_HOST_WAITING } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { SETUP_HOST_REFUSAL_WORDS as FROM_ASK } from "../../packages/broker/src/core/setup-agent/host-ask.js";
import { SETUP_HOST_REFUSAL_WORDS as FROM_REFUSAL } from "../../packages/broker/src/core/setup-agent/host-refusal.js";
import { REGISTRY_PROBLEM_MESSAGES } from "../../packages/contracts/src/project-registries.js";
import { TESTING_REASON_TEXT } from "../../packages/contracts/src/verification-result.js";

describe("the owner's wording: a setup run asks for an address (Cloud exact-matches these sentences)", () => {
  it("keeps the fixed error sentences Cloud passes on only on an exact match", () => {
    expect(SETUP_NEEDS_ADMIN).toBe("This setup change reaches outside the project's commands (an address, a secret, a registry, an integration or something Rovara does not recognise), so a company owner or admin must approve it.");
    expect(SETUP_HOST_NEEDS_ADMIN).toBe("An address for a setup run changes what the project's code can reach, so only a company owner or admin can allow or refuse it.");
    expect(SETUP_NO_HOST_WAITING).toBe("That address is not waiting for a decision any more. Open the project's setup again.");
  });
  it("keeps Cloud's mirrored contract words", () => {
    expect(REGISTRY_PROBLEM_MESSAGES.host_not_approved).toBe("The registry's address is not on the project's allowed addresses. Ask an admin to allow it, then try again.");
    expect(TESTING_REASON_TEXT.host_blocked).toBe("an address the setup needs is not allowed");
  });
  it("says the refusal words alike in both files, and an IP only as an IP number", () => {
    // (The two copies already differed before this change on `production`; only the changed words are compared.)
    for (const key of ["not_a_host", "address_literal", "ip_in_name", "paste_site", "link_shortener", "webhook_sink"] as const) expect(FROM_ASK[key]).toBe(FROM_REFUSAL[key]);
    expect(FROM_REFUSAL.not_a_host).toBe("Not a plain address.");
    expect(FROM_REFUSAL.address_literal).toBe("An IP number, not a name.");
    expect(FROM_REFUSAL.ip_in_name).toBe("A name that stands for an IP number.");
    for (const words of [...Object.values(FROM_REFUSAL), ...Object.values(FROM_ASK)]) expect(words).not.toMatch(/website|IP address/iu);
  });
});
