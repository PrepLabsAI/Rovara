import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runSdkChild } from "../support/model-sdk-compat-runner.js";
it("kills a hung child and waits for its exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-timeout-"));
    try {
        const result = await runSdkChild(process.execPath, ["-e", "setTimeout(()=>process.exit(0),500)"], { HOME: dir }, dir, 100);
        expect(result.timedOut).toBe(true);
        expect(result.code).not.toBe(0);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
it("kills an output flood rather than parsing or reporting it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-output-"));
    try {
        const result = await runSdkChild(process.execPath, ["-e", "const timer=setInterval(()=>process.stdout.write('x'.repeat(8192)),1);setTimeout(()=>{clearInterval(timer);process.exit(0)},500)"], { HOME: dir }, dir, 1000);
        expect(result.timedOut).toBe(false);
        expect(result.code).not.toBe(0);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
