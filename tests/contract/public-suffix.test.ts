// Plan 2, Task 17: the Public Suffix List the project network settings check domains against.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPublicSuffixMatcher, isPublicSuffix } from "../../packages/contracts/src/public-suffix.js";
import { PUBLIC_SUFFIX_LIST_COMMIT, PUBLIC_SUFFIX_RULES, registrableDomain } from "../../packages/contracts/src/public-suffix.js";

describe("the generated rules", () => {
  it("name the source commit, hold both sections, and cannot be changed at runtime", () => {
    expect(PUBLIC_SUFFIX_LIST_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    const source = readFileSync(new URL("../../packages/contracts/src/public-suffix-rules.ts", import.meta.url), "utf8");
    expect(source).toContain(`Commit: ${PUBLIC_SUFFIX_LIST_COMMIT}`);
    // ICANN section, PRIVATE section, a wildcard rule and an exception rule.
    for (const rule of ["com", "co.uk", "github.io", "s3.amazonaws.com", "*.ck", "!www.ck"]) expect(PUBLIC_SUFFIX_RULES.has(rule), rule).toBe(true);
    expect(PUBLIC_SUFFIX_RULES.size).toBeGreaterThan(5000);
    expect(Object.isFrozen(PUBLIC_SUFFIX_RULES)).toBe(true);
    const set = PUBLIC_SUFFIX_RULES as Set<string>;
    expect(() => set.add("evil.example")).toThrow(TypeError);
    expect(() => set.delete("com")).toThrow(TypeError);
    expect(() => set.clear()).toThrow(TypeError);
    expect(PUBLIC_SUFFIX_RULES.has("evil.example")).toBe(false);
    expect(PUBLIC_SUFFIX_RULES.has("com")).toBe(true);
  });
});

describe("isPublicSuffix", () => {
  it("is true for a TLD, a multi-label suffix, and a PRIVATE-section hosting suffix", () => {
    for (const name of ["com", "co.uk", "github.io", "s3.amazonaws.com", "dev"]) expect(isPublicSuffix(name), name).toBe(true);
  });

  it("is false for a registrable name and for one beneath a suffix", () => {
    for (const name of ["acme.com", "foo.github.io", "amazonaws.com", "registry.npmjs.org", "bar.co.uk", "a.s3.amazonaws.com"]) expect(isPublicSuffix(name), name).toBe(false);
  });

  it("follows a wildcard rule: *.ck makes every name directly under ck a suffix", () => {
    expect(isPublicSuffix("ck")).toBe(true);
    expect(isPublicSuffix("foo.ck")).toBe(true);
    expect(isPublicSuffix("bar.foo.ck")).toBe(false);
  });

  it("follows an exception rule: !www.ck makes www.ck registrable", () => {
    expect(isPublicSuffix("www.ck")).toBe(false);
    expect(registrableDomain("www.ck")).toBe("www.ck");
    expect(registrableDomain("a.www.ck")).toBe("www.ck");
    expect(registrableDomain("foo.ck")).toBeUndefined();
    expect(registrableDomain("a.foo.ck")).toBe("a.foo.ck");
  });

  it("follows wildcard rules whose bare name has no rule: *.sch.uk, *.kawasaki.jp, *.0emm.com", () => {
    for (const name of ["x.sch.uk", "foo.kawasaki.jp", "anything.0emm.com", "a.compute.amazonaws.com"]) expect(isPublicSuffix(name), name).toBe(true);
    for (const name of ["sch.uk", "kawasaki.jp", "0emm.com", "a.x.sch.uk", "a.foo.kawasaki.jp"]) expect(isPublicSuffix(name), name).toBe(false);
    expect(registrableDomain("a.x.sch.uk")).toBe("a.x.sch.uk");
    expect(registrableDomain("x.sch.uk")).toBeUndefined();
  });

  it("lets an exception rule beat the wildcard it sits under: !city.kawasaki.jp", () => {
    expect(isPublicSuffix("city.kawasaki.jp")).toBe(false);
    expect(registrableDomain("www.city.kawasaki.jp")).toBe("city.kawasaki.jp");
    expect(registrableDomain("foo.kawasaki.jp")).toBeUndefined();
  });

  it("reads a name without regard to case or a trailing dot, and treats an invalid name as no suffix", () => {
    expect(isPublicSuffix("CO.UK")).toBe(true);
    expect(isPublicSuffix("co.uk.")).toBe(true);
    for (const name of ["", ".", "a..b", ".com", "*.com"]) expect(isPublicSuffix(name), name).toBe(false);
  });

  it("treats an unknown top-level name as a suffix, as the list's default rule says", () => {
    expect(isPublicSuffix("localhost")).toBe(true);
    expect(registrableDomain("foo.localhost")).toBe("foo.localhost");
  });
});

describe("registrableDomain", () => {
  it("is the public suffix plus one label", () => {
    expect(registrableDomain("artifacts.acme.dev")).toBe("acme.dev");
    expect(registrableDomain("acme.co.uk")).toBe("acme.co.uk");
    expect(registrableDomain("www.acme.co.uk")).toBe("acme.co.uk");
    expect(registrableDomain("foo.github.io")).toBe("foo.github.io");
    expect(registrableDomain("x.y.foo.github.io")).toBe("foo.github.io");
    expect(registrableDomain("bucket.s3.amazonaws.com")).toBe("bucket.s3.amazonaws.com");
    expect(registrableDomain("ACME.COM")).toBe("acme.com");
  });

  it("is undefined for a public suffix and for an invalid name", () => {
    for (const name of ["com", "co.uk", "github.io", "s3.amazonaws.com", "", "a..b"]) expect(registrableDomain(name), name).toBeUndefined();
  });
});

describe("createPublicSuffixMatcher", () => {
  it("applies the rule that matches most labels, and an exception over every other rule", () => {
    const { isPublicSuffix: suffix, registrableDomain: registrable } = createPublicSuffixMatcher(new Set(["uk", "co.uk", "*.sch.uk", "!city.sch.uk"]));
    expect(suffix("co.uk")).toBe(true);
    expect(suffix("x.sch.uk")).toBe(true);
    expect(suffix("city.sch.uk")).toBe(false);
    expect(registrable("a.city.sch.uk")).toBe("city.sch.uk");
    expect(registrable("a.x.sch.uk")).toBe("a.x.sch.uk");
    expect(registrable("a.b.co.uk")).toBe("b.co.uk");
  });
});
