// Spec 048 FR-070 and FR-071: the page-mode log file is opened before the wizard and closed with
// the run, even when the wizard itself never starts; a log that stops working says so in the
// terminal once.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InitLog, OpenInitLogOptions } from "../../packages/cli/src/init/log-file.js";

const opened: Array<{ log: InitLog; options: OpenInitLogOptions | undefined; closed: number }> = [];

vi.mock("../../packages/cli/src/init/log-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/cli/src/init/log-file.js")>();
  return {
    ...actual,
    openInitLog: async (path: string, options?: OpenInitLogOptions) => {
      const log = await actual.openInitLog(path, options);
      const record = { log, options, closed: 0 };
      opened.push(record);
      return { ...log, close: async () => { record.closed += 1; await log.close(); } };
    },
  };
});

vi.mock("../../packages/cli/src/init/ui/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/cli/src/init/ui/index.js")>();
  return { ...actual, startInstallWizard: async () => { throw new Error("listen EADDRINUSE: address already in use 127.0.0.1"); } };
});

const { harness } = await import("../support/init-ui-harness.js");

afterEach(() => { opened.splice(0); });

describe("the install log file and the wizard", () => {
  it("closes the log file when the wizard fails to start", async () => {
    const h = await harness();
    expect(await h.run(["--ui"])).not.toBe(0);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.closed).toBe(1);
  });

  it("prints the log's one failure line in the terminal", async () => {
    const h = await harness();
    await h.run(["--ui"]);
    opened[0]?.options?.onError?.("The install log could not be written (EIO). The install goes on without it.");
    expect(h.err.join("")).toContain("The install log could not be written (EIO). The install goes on without it.\n");
  });
});
