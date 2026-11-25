// F1 lane L0: the settings schema. The row type refuses a row with no named reader; the cross-row rules refuse a repeated key, stack parameter, packed code or position; one function
// carries the never-loosen rule; one key may be in only one repository's rows; the tombstone list is empty until a removal lane lands.
import { describe, expect, it } from "vitest";
import {
  CARRIED_BY, CODE_SETTING_ROWS, INSTALL_ROWS, RESERVED_PACKED_CODES, SETTING_KEYS, SETTING_TOMBSTONES, SettingRowSchema, assertNoKeyInBoth, defineRow, effective, installRow, keysInBoth, settingRowProblems,
  type SettingRow,
} from "@agentx/contracts";

const customerRow: SettingRow = {
  key: "limit.month.person", levels: [{ level: "company", owner: "cloud" }, { level: "project", owner: "code" }], type: { kind: "usd", min: 0, max: 100000 }, default: "REQUIRED", unit: "usd",
  loosens: "higher", who: "company-admin", surfaces: ["web"], reader: "gateway", store: "control-plane-setting", failClosed: true, words: "The most one person may spend in a month.", audit: true,
};

describe("the settings row schema (F1 L0)", () => {
  it("accepts a customer row with two levels owned by two stores", () => {
    expect(defineRow(customerRow)).toBe(customerRow);
  });

  it("refuses a row with no reader, with an unknown reader, and with an undotted key", () => {
    const withoutReader = Object.fromEntries(Object.entries(customerRow).filter(([name]) => name !== "reader"));
    expect(() => defineRow(withoutReader as unknown as SettingRow)).toThrow(/reader/u);
    expect(() => defineRow({ ...customerRow, reader: "somebody" } as unknown as SettingRow)).toThrow(/reader/u);
    expect(() => defineRow({ ...customerRow, key: "undotted" })).toThrow(/dotted/u);
  });

  it("refuses a field the schema does not know (a strict row)", () => {
    expect(SettingRowSchema.safeParse({ ...customerRow, surprise: true }).success).toBe(false);
  });

  it("holds every install row to the schema, and the rows to the cross-row rules", () => {
    for (const row of CODE_SETTING_ROWS) expect(SettingRowSchema.safeParse(row).success, row.key).toBe(true);
    expect(settingRowProblems(CODE_SETTING_ROWS)).toEqual([]);
    expect(CODE_SETTING_ROWS.every((row) => row.reader.length > 0)).toBe(true);
  });

  it("finds a repeated key, stack parameter, packed code, packed key, packed order and list position", () => {
    const first = INSTALL_ROWS.find((row) => row.install.packed !== undefined && row.install.kept !== undefined && row.configKey !== undefined)!;
    const copy: SettingRow = { ...first, key: "install.control-plane.Copy" };
    const problems = settingRowProblems([first, copy]).join("\n");
    expect(problems).toContain("the stack parameter");
    expect(problems).toContain("the packed code");
    expect(problems).toContain("the packed key");
    expect(problems).toContain("the packed order");
    expect(problems).toContain("the kept-on-upgrade position");
    expect(problems).toContain("the config key");
    expect(settingRowProblems([first, first]).join("\n")).toContain(`the key ${first.key} is used by more than one row`);
  });

  it("builds an install row with the shared fields filled in, and refuses one with a bad packed code", () => {
    const row = installRow({ part: "runtime", parameter: "ExampleParameter", type: { kind: "text" }, default: "", words: "An example.", class: "operator", declaredIn: "neither", carriedBy: ["none"] });
    expect(row).toMatchObject({ key: "install.runtime.ExampleParameter", who: "install-operator", reader: "stack", store: "stack-parameter", failClosed: false, audit: false, surfaces: ["stack-parameter"] });
    expect(() => installRow({ part: "runtime", parameter: "Other", type: { kind: "text" }, default: "", words: "x", class: "operator", declaredIn: "neither", carriedBy: ["none"], packed: { key: "other", code: "XYZ", variable: "V", order: 1 } })).toThrow(/code/u);
  });

  it("gives every row a default its own type accepts (the table-driven check: a default that does not parse would stop a fresh install)", () => {
    for (const row of CODE_SETTING_ROWS) {
      if (row.default === "REQUIRED") continue;
      const { type } = row;
      if (type.kind === "choice") expect(type.values, row.key).toContain(row.default);
      if (type.kind === "int" && row.default !== "") {
        expect(Number.isInteger(Number(row.default)), row.key).toBe(true);
        if (type.min !== undefined) expect(Number(row.default), row.key).toBeGreaterThanOrEqual(type.min);
        if (type.max !== undefined) expect(Number(row.default), row.key).toBeLessThanOrEqual(type.max);
      }
      if (type.kind === "text") {
        if (type.max !== undefined) expect(row.default.length, row.key).toBeLessThanOrEqual(type.max);
        if (type.pattern !== undefined) expect(new RegExp(type.pattern, "u").test(row.default), row.key).toBe(true);
      }
    }
  });

  it("has a carried-by entry, with a reset condition, for every way an upgrade can supply a value, and every row names one", () => {
    for (const [kind, entry] of Object.entries(CARRIED_BY)) {
      expect(entry.supplies.length, kind).toBeGreaterThan(20);
      expect(entry.resetCondition.length, kind).toBeGreaterThan(20);
    }
    for (const row of INSTALL_ROWS) for (const kind of row.install.carriedBy) expect(CARRIED_BY, `${row.key} ${kind}`).toHaveProperty(kind);
  });
});

describe("effective(): the one never-loosen function (F1 L0)", () => {
  it("takes the stricter of a stored cap and the constant for a row where a higher value loosens", () => {
    const cap = { loosens: "higher" as const };
    expect(effective(cap, 3, 5)).toBe(3);
    expect(effective(cap, 9, 5)).toBe(5);
    expect(effective(cap, undefined, 5)).toBe(5);
  });

  it("takes the higher of a stored floor and the constant where a lower value loosens", () => {
    expect(effective({ loosens: "lower" }, 3, 5)).toBe(5);
    expect(effective({ loosens: "lower" }, 9, 5)).toBe(9);
  });

  it("keeps a switch off if either is off where on loosens, and on if either is on where off loosens", () => {
    expect(effective({ loosens: "on" }, true, false)).toBe(false);
    expect(effective({ loosens: "on" }, false, true)).toBe(false);
    expect(effective({ loosens: "on" }, true, true)).toBe(true);
    expect(effective({ loosens: "off" }, false, true)).toBe(true);
    expect(effective({ loosens: "off" }, false, false)).toBe(false);
  });

  it("takes the stored value of a row that loosens nothing, else the constant (learning has no `loosens`, so nothing turns it off)", () => {
    expect(effective({}, 7, 5)).toBe(7);
    expect(effective({}, true, false)).toBe(true);
    expect(effective({}, undefined, false)).toBe(false);
  });

  it("refuses a stored value and a constant of different types", () => {
    expect(() => effective({}, 3 as unknown as boolean, true)).toThrow(/same type/u);
  });
});

describe("the key list and the one-key-one-repository rule (F1 L0)", () => {
  it("exports Code's keys, and no key is in Cloud's rows too (Cloud's file is a follow-up: Cloud is not in this repository)", () => {
    expect(SETTING_KEYS).toEqual(CODE_SETTING_ROWS.map((row) => row.key));
    expect(new Set(SETTING_KEYS).size).toBe(SETTING_KEYS.length);
    const cloudFixture = ["limit.month.person", "limit.month.project", "limit.task"];
    expect(() => assertNoKeyInBoth(SETTING_KEYS, cloudFixture)).not.toThrow();
  });

  it("names the keys that are in both", () => {
    expect(keysInBoth(["a.b", "c.d"], ["c.d", "e.f", "c.d"])).toEqual(["c.d"]);
    expect(() => assertNoKeyInBoth(["a.b", "c.d"], ["c.d"])).toThrow("a setting key must be owned by one repository; in both Code's and Cloud's rows: c.d");
  });
});

describe("tombstones (F1 L0)", () => {
  it("are empty: L0, L1a-0 and L1b remove nothing", () => {
    expect(SETTING_TOMBSTONES).toEqual([]);
  });
});

describe("reserved packed codes (F1 L0)", () => {
  it("refuses a code Cloud's table already uses for something else, and Code's rows use none", () => {
    expect(RESERVED_PACKED_CODES).toHaveProperty("tx");
    // Typed as the plain row (not the literal row type, whose union the compiler narrows differently as rows come and go).
    const testServices: SettingRow = INSTALL_ROWS.find((row) => row.install.packed?.key === "testServices")!;
    const packed = testServices.install!.packed!;
    expect(packed.code).toBe("td");
    const clash: SettingRow = { ...testServices, key: "install.control-plane.Clash", install: { ...testServices.install!, parameter: "Clash", packed: { ...packed, key: "clash", code: "tx", order: 999 } } };
    expect(settingRowProblems([clash]).join("\n")).toContain("the packed code tx is reserved");
    for (const row of CODE_SETTING_ROWS) expect(RESERVED_PACKED_CODES, row.key).not.toHaveProperty(row.install?.packed?.code ?? "none");
  });
});
