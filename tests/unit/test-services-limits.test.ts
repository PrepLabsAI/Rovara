// DEC 254zm 2: the owner's settings for the test-services ceilings (contracts/test-services-limits.ts).
import { describe, expect, it } from "vitest";
import {
  TEST_SERVICES_CEILING_MARKER, TEST_SERVICES_LIMIT_BOUNDS, TEST_SERVICES_LIMIT_DEFAULTS, TEST_SERVICES_LIMIT_SENTENCES, TEST_SERVICES_MAX_CONTAINERS_VARIABLE, TEST_SERVICES_MAX_HELPER_MEMORY_VARIABLE,
  TEST_SERVICES_MAX_MEMORY_PERCENT_VARIABLE, TEST_SERVICES_OVER_LIMIT_SENTENCE, resolveTestServicesLimits, testServicesLimitInvalidSentence,
} from "@agentx/contracts";

const C = TEST_SERVICES_MAX_CONTAINERS_VARIABLE;
const H = TEST_SERVICES_MAX_HELPER_MEMORY_VARIABLE;
const P = TEST_SERVICES_MAX_MEMORY_PERCENT_VARIABLE;

describe("test services limits: defaults and the owner's settings", () => {
  it("defaults to about 12 containers, 1 GiB per helper and 40% of the VM", () => {
    expect(TEST_SERVICES_LIMIT_DEFAULTS).toEqual({ containers: 12, helperMemoryMiB: 1024, memoryPercent: 40 });
    expect(resolveTestServicesLimits({})).toEqual({ ok: true, limits: { containers: 12, helperMemoryMiB: 1024, memoryPercent: 40 } });
  });

  it("takes each setting from a plain whole number", () => {
    expect(resolveTestServicesLimits({ [C]: "20", [H]: "2048", [P]: "60" })).toEqual({ ok: true, limits: { containers: 20, helperMemoryMiB: 2048, memoryPercent: 60 } });
    expect(resolveTestServicesLimits({ [C]: "20" })).toEqual({ ok: true, limits: { containers: 20, helperMemoryMiB: 1024, memoryPercent: 40 } });
  });

  it("accepts exactly the bounds, which are the old hard limits", () => {
    expect(TEST_SERVICES_LIMIT_BOUNDS).toEqual({ containers: { min: 1, max: 96 }, helperMemoryMiB: { min: 64, max: 16384 }, memoryPercent: { min: 5, max: 75 } });
    expect(resolveTestServicesLimits({ [C]: "96", [H]: "16384", [P]: "75" })).toMatchObject({ ok: true, limits: { containers: 96, helperMemoryMiB: 16384, memoryPercent: 75 } });
    expect(resolveTestServicesLimits({ [C]: "1", [H]: "64", [P]: "5" })).toMatchObject({ ok: true, limits: { containers: 1, helperMemoryMiB: 64, memoryPercent: 5 } });
  });

  it("refuses a value one past either bound, naming the setting (never clamping)", () => {
    for (const [variable, bad] of [[C, "0"], [C, "97"], [H, "63"], [H, "16385"], [P, "4"], [P, "76"], [P, "100"]] as const) {
      expect(resolveTestServicesLimits({ [variable]: bad }), `${variable}=${bad}`).toEqual({ ok: false, variable });
    }
  });

  it("refuses an empty, signed, spaced, decimal, zero-led, hex or lettered value", () => {
    for (const bad of ["", " ", "12 ", " 12", "+12", "-12", "1.5", "012", "0x10", "1e2", "twelve", "12abc", "١٢", "1_2", "1234567"]) {
      expect(resolveTestServicesLimits({ [C]: bad }), JSON.stringify(bad)).toEqual({ ok: false, variable: C });
      expect(resolveTestServicesLimits({ [H]: bad }), JSON.stringify(bad)).toEqual({ ok: false, variable: H });
      expect(resolveTestServicesLimits({ [P]: bad }), JSON.stringify(bad)).toEqual({ ok: false, variable: P });
    }
  });

  it("names the first wrong setting, in a fixed order", () => {
    expect(resolveTestServicesLimits({ [C]: "x", [H]: "x", [P]: "x" })).toEqual({ ok: false, variable: C });
    expect(resolveTestServicesLimits({ [H]: "x", [P]: "x" })).toEqual({ ok: false, variable: H });
  });

  it("answers with fixed words that never hold the value", () => {
    const sentence = testServicesLimitInvalidSentence(C);
    expect(sentence).toBe(`Test services are not available: ${C} must be a whole number within its allowed range (it is left unset to use the default)`);
    expect(sentence).not.toMatch(/[0-9]/u);
    for (const text of [...Object.values(TEST_SERVICES_LIMIT_SENTENCES), TEST_SERVICES_OVER_LIMIT_SENTENCE]) expect(text).not.toMatch(/[0-9]/u);
    for (const text of Object.values(TEST_SERVICES_LIMIT_SENTENCES)) expect(text.startsWith(TEST_SERVICES_CEILING_MARKER)).toBe(true);
  });
});
