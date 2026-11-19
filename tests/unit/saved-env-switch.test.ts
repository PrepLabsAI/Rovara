// The saved environments switch: on only when exactly "1", and nothing reads the process environment unless the caller gives none.
import { describe, expect, it } from "vitest";
import { SAVED_ENVIRONMENTS_VARIABLE } from "../../packages/broker/src/core/test-env/switch.js";
import { savedEnvEnabled } from "../../packages/broker/src/core/test-env/saved-env-switch.js";

describe("the saved environments switch", () => {
  it("is on only for exactly 1", () => {
    for (const value of ["1"]) expect(savedEnvEnabled({ [SAVED_ENVIRONMENTS_VARIABLE]: value })).toBe(true);
    for (const value of [undefined, "", "0", "true", " 1", "1 ", "yes", "01"]) expect(savedEnvEnabled({ ...(value === undefined ? {} : { [SAVED_ENVIRONMENTS_VARIABLE]: value }) }), String(value)).toBe(false);
  });

  it("reads the given environment, not the process's", () => {
    const before = process.env[SAVED_ENVIRONMENTS_VARIABLE];
    process.env[SAVED_ENVIRONMENTS_VARIABLE] = "1";
    try {
      expect(savedEnvEnabled({})).toBe(false);
      expect(savedEnvEnabled()).toBe(true);
    } finally {
      if (before === undefined) delete process.env[SAVED_ENVIRONMENTS_VARIABLE]; else process.env[SAVED_ENVIRONMENTS_VARIABLE] = before;
    }
  });
});
