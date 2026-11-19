// Decision 46b: the two switches for local coding tools: what they come to (ON under Standard, OFF under Regulated, the company's switch off for every project), and that every change is audited BEFORE it is made and a change
// that cannot be recorded changes nothing.
import { describe, expect, it } from "vitest";
import type { LocalToolsSettings, LocalToolsSettingsStore } from "../../../packages/broker/src/lessons/local-tools.js";
import { readLocalToolsState, setCompanyLocalTools, setProjectLocalTools } from "../../../packages/broker/src/lessons/local-tools-setting.js";
import type { LessonAuditEvent, LessonAuditSink } from "../../../packages/broker/src/lessons/ports.js";
import type { LearningSettings } from "../../../packages/broker/src/lessons/policy.js";
import { Audit, PROJECT, WS } from "./lesson-helpers.js";

function store(initial: Partial<LocalToolsSettings> = {}, fail?: "read" | "write") {
  const state = { projectOn: initial.projectOn, companyStays: initial.companyStays ?? false, writes: [] as string[] };
  const s: LocalToolsSettingsStore = {
    read: async () => { if (fail === "read") throw new Error("down"); return { projectOn: state.projectOn, companyStays: state.companyStays }; },
    readCompany: async () => { if (fail === "read") throw new Error("down"); return state.companyStays; },
    setProject: async (_w, _p, enabled) => { if (fail === "write") throw new Error("down"); state.projectOn = enabled; state.writes.push(`project:${String(enabled)}`); },
    setCompany: async (_w, stays) => { if (fail === "write") throw new Error("down"); state.companyStays = stays; state.writes.push(`company:${String(stays)}`); },
  };
  return { s, state };
}
const settings = (value: LearningSettings = {}) => ({ read: async () => ({ preset: "standard" as const, ...value }) });
const refusing: LessonAuditSink = { emit: async () => { throw new Error("no ledger"); } };

describe("what the switches come to", () => {
  it("is ON by default under Standard, OFF under Regulated whatever the project chose, and OFF for every project while the company keeps lessons in Rovara", async () => {
    expect(await readLocalToolsState({ localTools: store().s, settings: settings() }, WS, PROJECT)).toEqual({ enabled: true, preset: "standard", companyStays: false });
    expect(await readLocalToolsState({ localTools: store({ projectOn: false }).s, settings: settings() }, WS, PROJECT)).toMatchObject({ enabled: false, own: false, reason: "project_setting" });
    expect(await readLocalToolsState({ localTools: store({ projectOn: true }).s, settings: settings({ preset: "regulated" }) }, WS, PROJECT)).toMatchObject({ enabled: false, own: true, reason: "regulated", preset: "regulated" });
    expect(await readLocalToolsState({ localTools: store({ projectOn: true, companyStays: true }).s, settings: settings() }, WS, PROJECT)).toMatchObject({ enabled: false, reason: "company_stays", companyStays: true });
    await expect(readLocalToolsState({ localTools: store({}, "read").s, settings: settings() }, WS, PROJECT)).rejects.toThrow();
  });
});

describe("a change is audited first", () => {
  it("records who and the new value (scope and the setting only), then writes", async () => {
    const audit = new Audit(), { s, state } = store();
    expect(await setProjectLocalTools({ localTools: s, audit, now: () => 5 }, { workspaceId: WS, project: PROJECT, enabled: false, by: "pia" })).toEqual({ ok: true, changed: true });
    expect(await setCompanyLocalTools({ localTools: s, audit, now: () => 5 }, { workspaceId: WS, stays: true, by: "ada" })).toEqual({ ok: true, changed: true });
    expect(audit.events.map((e: LessonAuditEvent) => [e.action, e.actor, e.facts])).toEqual([["lesson.local_tools_switched", "pia", { scope: "project", enabled: false }], ["lesson.local_tools_switched", "ada", { scope: "company", enabled: false }]]);
    expect(state.writes).toEqual(["project:false", "company:true"]);
    // the same value again is not a change
    expect(await setProjectLocalTools({ localTools: s, audit, now: () => 6 }, { workspaceId: WS, project: PROJECT, enabled: false, by: "pia" })).toEqual({ ok: true, changed: false });
  });

  it("a change that cannot be recorded, or a setting that cannot be read or written, changes nothing", async () => {
    const a = store();
    expect(await setProjectLocalTools({ localTools: a.s, audit: refusing, now: () => 1 }, { workspaceId: WS, project: PROJECT, enabled: false, by: "pia" })).toEqual({ ok: false, code: "audit_unavailable" });
    expect(await setCompanyLocalTools({ localTools: a.s, audit: refusing, now: () => 1 }, { workspaceId: WS, stays: true, by: "ada" })).toEqual({ ok: false, code: "audit_unavailable" });
    expect(a.state.writes).toEqual([]);
    expect(await setProjectLocalTools({ localTools: store({}, "read").s, audit: new Audit(), now: () => 1 }, { workspaceId: WS, project: PROJECT, enabled: false, by: "pia" })).toEqual({ ok: false, code: "unreadable" });
    expect(await setCompanyLocalTools({ localTools: store({}, "write").s, audit: new Audit(), now: () => 1 }, { workspaceId: WS, stays: true, by: "ada" })).toEqual({ ok: false, code: "unreadable" });
  });
});
