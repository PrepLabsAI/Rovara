import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readReportPartsFile } from "../../packages/worker/src/verification/report-file.js";

async function workspace(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "te-a4-report-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const valid = '{"schemaVersion":1,"measures":[{"name":"bytes","unit":"B","value":12,"direction":"down_good"}]}';
describe("report parts file", () => {
  it("reads the explicitly named fresh measures, CTRF and TRX files through the common reader", async () => workspace(async (root) => {
    for (const name of ["measures.json", "ctrf.json", "trx.xml"]) {
      await writeFile(join(root, name), await readFile(new URL(`../fixtures/report-adapters/${name}`, import.meta.url)));
      const read = await readReportPartsFile({ root, cwd: ".", argument: name, notBeforeMs: Date.now() });
      expect(read).toMatchObject({ ok: true, parts: { format: name === "measures.json" ? "measures" : name === "ctrf.json" ? "ctrf" : "trx" } });
    }
  }));
  it("refuses a symlink file or directory, path escape, missing file and missing freshness", async () => workspace(async (root) => {
    await mkdir(join(root, "real")); await writeFile(join(root, "real", "report.json"), valid);
    await symlink(join(root, "real"), join(root, "linked"));
    await symlink(join(root, "real", "report.json"), join(root, "file.json"));
    for (const argument of ["file.json", "linked/report.json", "../outside.json"]) expect(await readReportPartsFile({ root, cwd: ".", argument, notBeforeMs: Date.now() })).toMatchObject({ ok: false, reason: "unsafe_path" });
    expect(await readReportPartsFile({ root, cwd: ".", argument: "absent", notBeforeMs: Date.now() })).toMatchObject({ ok: false, reason: "missing" });
    expect(await readReportPartsFile({ root, cwd: ".", argument: "real/report.json", notBeforeMs: undefined })).toMatchObject({ ok: false, reason: "stale" });
  }));
  it("refuses invalid UTF-8, malformed JSON and oversized files; reports future versions as newer", async () => workspace(async (root) => {
    const read = () => readReportPartsFile({ root, cwd: ".", argument: "report.json", notBeforeMs: Date.now() });
    await writeFile(join(root, "report.json"), Buffer.concat([Buffer.from(valid.slice(0, valid.indexOf("bytes"))), Buffer.from([0xff]), Buffer.from(valid.slice(valid.indexOf("bytes") + 5)) ]));
    expect(await read()).toMatchObject({ ok: false, reason: "unreadable" });
    await writeFile(join(root, "report.json"), "{"); expect(await read()).toMatchObject({ ok: false, reason: "malformed" });
    await writeFile(join(root, "report.json"), valid + " ".repeat(8 * 1024 * 1024)); expect(await read()).toMatchObject({ ok: false, reason: "too_large" });
    await writeFile(join(root, "report.json"), '{"schemaVersion":2,"measures":[]}'); expect(await read()).toEqual({ ok: false, reason: "newer" });
  }));
});
