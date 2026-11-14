// Java reports J1, the parts that need a file system that misbehaves: a parent folder swapped for a link between the check and the open, the byte total checked before each file is read, and a file that says
// its size is 0 and then keeps going. `node:fs/promises` is wrapped so a test can act at the moment of the open and count the bytes read; everything else is the real file system.
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((path: string) => void),
  afterOpen: undefined as undefined | ((path: string) => void),
  statSize: undefined as undefined | ((path: string) => number | undefined),
  bytesRead: 0,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown> & { open: (...args: unknown[]) => Promise<FileHandle> }>();
  return {
    ...actual,
    open: async (path: string, ...rest: unknown[]) => {
      hooks.beforeOpen?.(String(path));
      const handle = await actual.open(path, ...rest);
      hooks.afterOpen?.(String(path));
      return new Proxy(handle, {
        get(target, property) {
          const value = Reflect.get(target, property) as unknown;
          if (property === "stat") return async () => { const real = await target.stat(); const size = hooks.statSize?.(String(path)); return size === undefined ? real : Object.assign(Object.create(Object.getPrototypeOf(real) as object) as object, real, { size }); };
          if (property === "read") return async (...args: Parameters<typeof target.read>) => { const result = await (target.read as (...a: unknown[]) => Promise<{ bytesRead: number }>)(...args); hooks.bytesRead += result.bytesRead; return result; };
          if (property === "readFile") return async () => { const buffer = await target.readFile(); hooks.bytesRead += buffer.length; return buffer; };
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  };
});

const { readJunitFolder, readTestReportAt, REPORT_FOLDER_MAX_TOTAL_BYTES } = await import("../../packages/worker/src/verification/test-report-folder.js");
const { TEST_REPORT_MAX_BYTES } = await import("../../packages/worker/src/verification/test-report.js");

const suite = (cls: string, name: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${cls}" tests="1"><testcase name="${name}" classname="${cls}" time="0.01"/></testsuite>`;
let dir: string;
let outside: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rovara-report-race-"));
  outside = mkdtempSync(join(tmpdir(), "rovara-report-race-outside-"));
  hooks.beforeOpen = hooks.afterOpen = hooks.statSize = undefined;
  hooks.bytesRead = 0;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

describe("a parent folder swapped for a link after the check", () => {
  it("is caught after the open: the file read is not the one the path names inside the workspace", async () => {
    mkdirSync(join(dir, "target", "reports"), { recursive: true });
    writeFileSync(join(dir, "target", "reports", "TEST-a.A.xml"), suite("a.A", "inside"));
    mkdirSync(join(outside, "reports"));
    writeFileSync(join(outside, "reports", "TEST-a.A.xml"), suite("z.Z", "leaked"));
    // `target` becomes a link to the outside folder for the moment of the open, and is put back at once: every later check of the path sees the workspace again.
    hooks.beforeOpen = (path) => {
      if (!path.endsWith("TEST-a.A.xml")) return;
      renameSync(join(dir, "target"), join(dir, "target.aside"));
      symlinkSync(outside, join(dir, "target"));
    };
    hooks.afterOpen = (path) => {
      if (!path.endsWith("TEST-a.A.xml")) return;
      unlinkSync(join(dir, "target"));
      renameSync(join(dir, "target.aside"), join(dir, "target"));
    };
    const result = await readJunitFolder(join(dir, "target", "reports"), dir);
    expect(JSON.stringify(result)).not.toContain("leaked");
    expect(result).toMatchObject({ filesRead: 0, filesRefused: 1, complete: false });
  });
  it("is caught for a single report file too", async () => {
    mkdirSync(join(dir, "target"));
    writeFileSync(join(dir, "target", "one.xml"), suite("a.A", "inside"));
    writeFileSync(join(outside, "one.xml"), suite("z.Z", "leaked"));
    hooks.beforeOpen = (path) => { if (path.endsWith("one.xml")) { renameSync(join(dir, "target"), join(dir, "target.aside")); symlinkSync(outside, join(dir, "target")); } };
    hooks.afterOpen = (path) => { if (path.endsWith("one.xml")) { unlinkSync(join(dir, "target")); renameSync(join(dir, "target.aside"), join(dir, "target")); } };
    const read = await readTestReportAt(dir, "target/one.xml");
    expect(read.report).toBeUndefined();
    expect(read.problem).toBe("refused");
  });
  it("without the swap the same folder is read", async () => {
    mkdirSync(join(dir, "target", "reports"), { recursive: true });
    writeFileSync(join(dir, "target", "reports", "TEST-a.A.xml"), suite("a.A", "inside"));
    expect((await readJunitFolder(join(dir, "target", "reports"), dir)).report?.total).toBe(1);
  });
});

describe("the byte total is checked before a file is read", () => {
  it("never reads past the total: the file that would pass it is not read at all", async () => {
    const size = TEST_REPORT_MAX_BYTES - 1000;
    for (let index = 0; index < 9; index += 1) {
      const path = join(dir, `TEST-f${String(index)}.xml`);
      writeFileSync(path, suite(`f.F${String(index)}`, "t"));
      truncateSync(path, size);
    }
    const result = await readJunitFolder(dir);
    expect(result.report).toBeUndefined();
    expect(result.complete).toBe(false);
    expect(result.notes.join(" ")).toMatch(/bytes/u);
    expect(hooks.bytesRead).toBeLessThanOrEqual(REPORT_FOLDER_MAX_TOTAL_BYTES);
  });
});

describe("a file that reports size 0 and keeps going", () => {
  it("is cut at the per-file limit, not read to the end", async () => {
    writeFileSync(join(dir, "TEST-a.A.xml"), suite("a.A", "t"));
    const grown = join(dir, "TEST-grown.xml");
    writeFileSync(grown, suite("g.G", "t"));
    truncateSync(grown, TEST_REPORT_MAX_BYTES * 2);
    hooks.statSize = (path) => (path.endsWith("TEST-grown.xml") ? 0 : undefined);
    const result = await readJunitFolder(dir);
    expect(result).toMatchObject({ filesRead: 1, filesMalformed: 1, complete: false });
    expect(result.report?.tests.map((test) => test.name).join("|")).toContain("too large");
    // The grown file gave up at the limit plus one byte, not its whole 16 MiB.
    expect(hooks.bytesRead).toBeLessThanOrEqual(TEST_REPORT_MAX_BYTES + 1 + 1000);
  });
});
