// F1 lanes L1a-0 and L1a-1: the install lists are DERIVED from the install rows.
//
// tests/contract/golden/install-settings.base.golden.json is a copy of the hand-kept literals taken at the base commit, before L1a-0 (OPERATOR_PARAMETERS per part in order, the legacy
// refusal list of named-environment-only parameters, BROKER_SETTINGS code, variable and flags in order). L1a-0 proved the derived lists EQUAL it. It is never updated.
// tests/contract/golden/install-settings.golden.json is what the lists are NOW. L1a-1 changed them deliberately, and this file states every difference with its reason (KEPT_ADDED,
// DELETED_PARAMETERS, NAMED_ONLY_CORRECTION); the golden is checked to be exactly the base plus those differences, so no change can slip in without a reason here.
// The rebase of 2026-11-25 onto code/next (ff38d0e00) did not touch either golden file: the two changes that landed on code/next after the base commit e2344f187 (the PublicApiUrl row added
// by 515e9d67c, the TaskPersonProofEnabled name deleted by 356c3ae57) are stated as ON_CODE_NEXT_SINCE_BASE below, and the derived lists are checked to be the golden PLUS exactly those.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BROKER_SETTINGS, CODE_SETTING_ROWS, INSTALL_ROWS, RESERVED_PACKED_CODES, STACK_PARTS, brokerSettingsFromRows, namedEnvironmentOnlyFromRows, operatorParametersFromRows, rowStackParameters } from "@agentx/contracts";
import { NAMED_ENVIRONMENT_ONLY_PARAMETERS } from "../../packages/cli/src/deploy/parameter-update.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";

interface Golden {
  operatorParameters: Record<string, string[]>;
  namedEnvironmentOnlyParameters: string[];
  brokerSettings: Array<{ key: string; code: string; variable: string; httpsOrigin?: true; switchFlag?: true }>;
}
const read = (file: string) => JSON.parse(readFileSync(`tests/contract/golden/${file}`, "utf8")) as Golden;
const base = read("install-settings.base.golden.json");
const golden = read("install-settings.golden.json");

const SIGN_IN_BETA = "beta's deployed value differs from the template default (beta snapshot 2026-11-25) and an upgrade with no stored sign-in used to reset it";
const SIGN_IN_PLAN = "the plan names it among the conditional carries of the production parameter-reset check (SSM sign-in absent resets it); beta's value equals the default, so beta cannot show the difference";
const SIGN_IN_UNIT = "one unit with the sign-in parameters above: signInStackParameters sends the whole family or none, so carrying part of it (an issuer without its required claim and values) would loosen company sign-in";
const PROVIDER_KEY = "the plan names it (settings without models.openRouter used to reset it to empty); beta's value equals the default";
const SLACK_OUTPUT = "beta's deployed value differs from the template default and is supplied only from the control plane's outputs: with no such output an upgrade used to reset it to empty";

/** The kept-on-upgrade additions of L1a-1, per part in list order, each with the reason it joins. */
const KEPT_ADDED: Record<string, Array<[string, string]>> = {
  runtime: [["OpenRouterSecretArn", PROVIDER_KEY]],
  "control-plane": [
    ["SlackTeamId", SIGN_IN_BETA], ["DeveloperSignInSlack", SIGN_IN_UNIT], ["DeveloperSignInSlackSince", SIGN_IN_UNIT], ["DeveloperOidcIssuer", SIGN_IN_PLAN], ["DeveloperOidcClientId", SIGN_IN_PLAN],
    ["DeveloperOidcRequiredClaim", SIGN_IN_UNIT], ["DeveloperOidcRequiredValues", SIGN_IN_UNIT], ["DeveloperOidcDisplayName", SIGN_IN_PLAN], ["DeveloperOidcSince", SIGN_IN_PLAN],
    ["DeveloperSignInGithub", SIGN_IN_BETA], ["DeveloperGithubClientId", SIGN_IN_BETA], ["DeveloperGithubSince", SIGN_IN_BETA], ["OpenRouterSecretArn", PROVIDER_KEY],
  ],
  slack: [
    ["OpenRouterSecretArn", PROVIDER_KEY], ["ChannelRequestQueueUrl", SLACK_OUTPUT], ["ChannelEventQueueUrl", SLACK_OUTPUT], ["SlackAdapterCommandsUrl", SLACK_OUTPUT], ["SlackAdapterSecretName", SLACK_OUTPUT],
  ],
};

/** The two dead parameters deleted with their packed broker settings (nothing in the broker reads either variable: only a handler no code imports asks for the flags). */
const DELETED_PARAMETERS = {
  control_plane: ["TaskPeoplePublicInvitationsEnabled", "TaskPeoplePrivateInvitationsEnabled"],
  packedKeys: ["taskPeoplePublicInvitations", "taskPeoplePrivateInvitations"],
  packedCodes: ["tu", "tv"],
};

/**
 * What changed on code/next between the base commit e2344f187 and the rebase of 2026-11-25 (ff38d0e00), in the lists the rows derive. Each line is a stated difference from the base golden.
 *  - 515e9d67c (CODE-PUBLIC-URL, DEC 254zzz505), new on code/next since e2344f187: the PublicApiUrl parameter. It is kept on upgrade on the foundation and on the control plane (last in each
 *    list) and the broker gets its host packed as `pu` (httpsOrigin), after every other setting. Its row is `install.control-plane.PublicApiUrl`.
 *  - 356c3ae57 (ARCH-D6, DEC 254zzz459), new on code/next since e2344f187: the CLI no longer keeps TaskPersonProofEnabled (the parameter was deleted with the task-person proof construct), so
 *    its row is deleted here too.
 *  - eef504228 (G1 CORE-RUN-STOP-RELAY, train 56, merged 2026-11-25), new on code/next since ff38d0e00: the broker setting `coreOutboxStreamRelay` (code `rl`, variable ROVARA_CORE_OUTBOX_STREAM_RELAY),
 *    a constant the template writes (not a stack parameter), packed right after `coreSystemRuns` and before `slackCompanyWorkspaces`. Its row is `core.outboxStreamRelay` (declaredIn neither, like install.layout).
 */
const ON_CODE_NEXT_SINCE_BASE = {
  keptAdded: { foundation: ["PublicApiUrl"], "control-plane": ["PublicApiUrl"] } as Record<string, string[]>,
  deletedFromKept: { "control-plane": ["TaskPersonProofEnabled"] } as Record<string, string[]>,
  packedAdded: [{ key: "publicApiUrl", code: "pu", variable: "ROVARA_PUBLIC_API_URL", httpsOrigin: true }] as Golden["brokerSettings"],
  /** Packed settings that sit in the middle of the list: inserted right after the named key. */
  packedInserted: [{ after: "coreSystemRuns", entry: { key: "coreOutboxStreamRelay", code: "rl", variable: "ROVARA_CORE_OUTBOX_STREAM_RELAY" } }] as Array<{ after: string; entry: Golden["brokerSettings"][number] }>,
};

/** The golden's packed settings with each inserted entry put right after the one it names, then the appended ones. */
function packedNow(): Golden["brokerSettings"] {
  const list = [...golden.brokerSettings];
  for (const { after, entry } of ON_CODE_NEXT_SINCE_BASE.packedInserted) list.splice(list.findIndex((each) => each.key === after) + 1, 0, entry);
  return [...list, ...ON_CODE_NEXT_SINCE_BASE.packedAdded];
}

/** The lists the code derives NOW: the golden (the lists as L1a-1 left them) with the code/next changes since the base applied, each stated above. */
const now = {
  operatorParameters: Object.fromEntries(Object.entries(golden.operatorParameters).map(([part, names]) => [
    part, [...names.filter((name) => !(ON_CODE_NEXT_SINCE_BASE.deletedFromKept[part] ?? []).includes(name)), ...(ON_CODE_NEXT_SINCE_BASE.keptAdded[part] ?? [])],
  ])),
  namedEnvironmentOnlyParameters: golden.namedEnvironmentOnlyParameters,
  brokerSettings: packedNow(),
};

/** The legacy refusal list as corrected: the parameters of the legacy-capable stacks that only named environments declare (derived from `declaredIn`). The 18 names the old list had are all declared by both layouts. */
const NAMED_ONLY_CORRECTION = ["PermissionsBoundaryArn", "BudgetMonthlyUsd", "BudgetScope", "NatEgressAddresses"];

describe("the golden files state every L1a-1 difference from the base lists, and nothing else", () => {
  it("OPERATOR_PARAMETERS: the base, without the two deleted parameters, plus each addition in KEPT_ADDED", () => {
    const expected = Object.fromEntries(Object.entries(base.operatorParameters).map(([part, names]) => [
      part,
      [...names.filter((name) => !(part === "control-plane" && DELETED_PARAMETERS.control_plane.includes(name))), ...(KEPT_ADDED[part] ?? []).map(([name]) => name)],
    ]));
    expect(golden.operatorParameters).toEqual(expected);
  });

  it("every addition has a reason, is kept in no earlier list and is declared by its stack", () => {
    for (const [part, additions] of Object.entries(KEPT_ADDED)) {
      for (const [name, reason] of additions) {
        expect(reason.length, `${part}/${name}`).toBeGreaterThan(20);
        expect(base.operatorParameters[part], `${part}/${name} was already kept`).not.toContain(name);
        expect(INSTALL_ROWS.some((row) => rowStackParameters(row).some((each) => each.part === part && each.parameter === name)), `${part}/${name} has a row`).toBe(true);
      }
    }
  });

  it("NAMED_ENVIRONMENT_ONLY: the corrected list replaces the base's 18 names, none of which is named-only", () => {
    expect(golden.namedEnvironmentOnlyParameters).toEqual(NAMED_ONLY_CORRECTION);
    expect(base.namedEnvironmentOnlyParameters).toHaveLength(18);
    for (const name of base.namedEnvironmentOnlyParameters) expect(golden.namedEnvironmentOnlyParameters, `${name} is declared by both layouts`).not.toContain(name);
  });

  it("BROKER_SETTINGS: the base without the two settings of the two deleted parameters, in the same order", () => {
    expect(golden.brokerSettings).toEqual(base.brokerSettings.filter((entry) => !DELETED_PARAMETERS.packedKeys.includes(entry.key)));
    expect(base.brokerSettings.filter((entry) => DELETED_PARAMETERS.packedKeys.includes(entry.key)).map((entry) => entry.code)).toEqual(DELETED_PARAMETERS.packedCodes);
  });
});

describe("OPERATOR_PARAMETERS is derived from the rows (F1 L1a-0, grown in L1a-1)", () => {
  it("is the golden list (plus what landed on code/next since the base) for every part, in the same order", () => {
    expect(OPERATOR_PARAMETERS).toEqual(now.operatorParameters);
    expect(operatorParametersFromRows(CODE_SETTING_ROWS)).toEqual(now.operatorParameters);
    expect(Object.keys(OPERATOR_PARAMETERS).sort()).toEqual([...STACK_PARTS].sort());
  });

  it("drops nothing that was kept except the deleted parameters (never loosen: a kept value is never forgotten)", () => {
    const before = Object.entries(base.operatorParameters).flatMap(([part, names]) => names.map((name) => `${part}/${name}`));
    const now = new Set(Object.entries(OPERATOR_PARAMETERS).flatMap(([part, names]) => names.map((name) => `${part}/${name}`)));
    const dropped = before.filter((entry) => !now.has(entry));
    expect(dropped.sort()).toEqual([...DELETED_PARAMETERS.control_plane, ...ON_CODE_NEXT_SINCE_BASE.deletedFromKept["control-plane"]!].map((name) => `control-plane/${name}`).sort());
  });

  it("no longer names TaskPersonProofEnabled (deleted on code/next by 356c3ae57, new since e2344f187), and has the PublicApiUrl row's two kept entries last (515e9d67c)", () => {
    expect(Object.values(OPERATOR_PARAMETERS).flat()).not.toContain("TaskPersonProofEnabled");
    expect(INSTALL_ROWS.some((row) => rowStackParameters(row).some((each) => each.parameter === "TaskPersonProofEnabled"))).toBe(false);
    expect(OPERATOR_PARAMETERS.foundation).toEqual(["PublicApiUrl"]);
    expect(OPERATOR_PARAMETERS["control-plane"].at(-1)).toBe("PublicApiUrl");
  });

  it("no longer names the two deleted parameters, which no row, list or template has", () => {
    for (const name of DELETED_PARAMETERS.control_plane) {
      expect(Object.values(OPERATOR_PARAMETERS).flat(), name).not.toContain(name);
      expect(INSTALL_ROWS.some((row) => rowStackParameters(row).some((each) => each.parameter === name)), name).toBe(false);
    }
  });
});

describe("NAMED_ENVIRONMENT_ONLY_PARAMETERS is derived from the rows (F1 L1a-1)", () => {
  it("is the corrected list: the parameters of the legacy-capable stacks that only named environments declare", () => {
    expect([...NAMED_ENVIRONMENT_ONLY_PARAMETERS]).toEqual(golden.namedEnvironmentOnlyParameters);
    expect(namedEnvironmentOnlyFromRows(CODE_SETTING_ROWS)).toEqual(golden.namedEnvironmentOnlyParameters);
  });

  it("names exactly the rows declared by the named layout only, on a stack the legacy deployment has", () => {
    const legacyParts = new Set(["foundation", "runtime", "control-plane", "slack"]);
    // A name the legacy layout declares on any legacy-capable stack is not named-only (515e9d67c: PublicApiUrl is on the legacy control plane, but not on the legacy foundation).
    const declaredByLegacy = new Set(INSTALL_ROWS.filter((row) => (row.install.declaredIn === "both" || row.install.declaredIn === "legacy") && legacyParts.has(row.install.part)).map((row) => row.install.parameter));
    const expected = new Set(INSTALL_ROWS.filter((row) => row.install.declaredIn === "named" && row.install.parameter !== undefined && legacyParts.has(row.install.part) && !declaredByLegacy.has(row.install.parameter)).map((row) => row.install.parameter));
    expect(new Set(NAMED_ENVIRONMENT_ONLY_PARAMETERS)).toEqual(expected);
  });
});

describe("BROKER_SETTINGS is derived from the rows (F1 L1a-0, two settings fewer in L1a-1)", () => {
  it("has the golden keys, codes, variables and flags in the same order", () => {
    const derived = Object.entries(BROKER_SETTINGS).map(([key, spec]) => ({ key, ...spec }));
    expect(derived).toEqual(now.brokerSettings);
    expect(JSON.stringify(derived)).toBe(JSON.stringify(now.brokerSettings));
    expect(Object.keys(brokerSettingsFromRows(CODE_SETTING_ROWS))).toEqual(now.brokerSettings.map((entry) => entry.key));
  });

  it("has a spec with no flag key it does not have (the broker tests ask `switchFlag in spec`)", () => {
    for (const entry of now.brokerSettings) {
      const spec = (BROKER_SETTINGS as Record<string, object>)[entry.key]!;
      expect("httpsOrigin" in spec, entry.key).toBe(entry.httpsOrigin !== undefined);
      expect("switchFlag" in spec, entry.key).toBe(entry.switchFlag !== undefined);
    }
  });

  it("uses each two-letter code once, and never a retired or reserved one", () => {
    const codes = Object.values(BROKER_SETTINGS).map((spec) => spec.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[a-z]{2}$/u);
    for (const code of DELETED_PARAMETERS.packedCodes) {
      expect(codes).not.toContain(code);
      expect(Object.hasOwn(RESERVED_PACKED_CODES, code), `${code} is reserved so it is never reused`).toBe(true);
    }
  });
});

describe("every parameter still named anywhere has a row (F1 L1a-0), and the deleted ones are gone", () => {
  it("has a row for every name in the base lists except the deleted parameters (the two invitation switches, and TaskPersonProofEnabled deleted on code/next by 356c3ae57)", () => {
    const named = new Set(INSTALL_ROWS.flatMap((row) => rowStackParameters(row).map((each) => each.parameter)));
    const missing = [...Object.values(base.operatorParameters).flat(), ...base.namedEnvironmentOnlyParameters].filter((name) => !named.has(name));
    expect([...new Set(missing)].sort()).toEqual([...DELETED_PARAMETERS.control_plane, ...ON_CODE_NEXT_SINCE_BASE.deletedFromKept["control-plane"]!].sort());
  });
});
