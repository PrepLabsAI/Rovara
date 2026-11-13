// The two switches of decision 46b on the document store, on the items a hosted install keeps them on (`LESSONSET#LOCALTOOLS` under the project, `LESSONSET#COMPANYSTAY` under the company): unset means the project is on and
// lessons may leave; a stored value that is not a boolean is not "unset" (the read throws, so the caller refuses); the items name no person.
import { teamRecordPk } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import { DocumentLocalToolsSettings } from "../../../packages/lessons/src/document-settings.js";
import { MemoryDocumentStore } from "../../../packages/core/src/ports/memory-document-store.js";
import { PROJECT, WS } from "./lesson-helpers.js";

describe("DocumentLocalToolsSettings", () => {
  it("reads unset as on and not staying, writes each switch on its own item with no person, and reads it back", async () => {
    const store = new MemoryDocumentStore();
    const settings = new DocumentLocalToolsSettings(store);
    expect(await settings.read(WS, PROJECT)).toEqual({ companyStays: false });
    expect(await settings.readCompany(WS)).toBe(false);
    await settings.setProject(WS, PROJECT, false, 5);
    await settings.setCompany(WS, true, 6);
    expect(await settings.read(WS, PROJECT)).toEqual({ projectOn: false, companyStays: true });
    expect(await settings.read(WS, "other")).toEqual({ companyStays: true });
    expect(await settings.readCompany(WS)).toBe(true);
    expect(await store.get({ pk: teamRecordPk(WS, PROJECT), sk: "LESSONSET#LOCALTOOLS" })).toEqual({ pk: teamRecordPk(WS, PROJECT), sk: "LESSONSET#LOCALTOOLS", entityType: "LESSON_SETTINGS", enabled: false, updatedAt: 5 });
    expect(await store.get({ pk: teamRecordPk(WS, undefined), sk: "LESSONSET#COMPANYSTAY" })).toEqual({ pk: teamRecordPk(WS, undefined), sk: "LESSONSET#COMPANYSTAY", entityType: "LESSON_SETTINGS", stays: true, updatedAt: 6 });
  });

  it("a stored value that is not a boolean throws instead of reading as unset", async () => {
    const store = new MemoryDocumentStore();
    const settings = new DocumentLocalToolsSettings(store);
    await store.put({ item: { pk: teamRecordPk(WS, PROJECT), sk: "LESSONSET#LOCALTOOLS", enabled: "yes" } });
    await expect(settings.read(WS, PROJECT)).rejects.toThrow("not valid");
    await store.put({ item: { pk: teamRecordPk(WS, PROJECT), sk: "LESSONSET#LOCALTOOLS", enabled: true } });
    await store.put({ item: { pk: teamRecordPk(WS, undefined), sk: "LESSONSET#COMPANYSTAY", stays: 1 } });
    await expect(settings.read(WS, PROJECT)).rejects.toThrow("not valid");
    await expect(settings.readCompany(WS)).rejects.toThrow("not valid");
  });
});
