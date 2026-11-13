import { it, expect } from "vitest";
import { runSdkCompatibility } from "../support/model-sdk-compat-runner.js";
const scratch = process.env.ROVARA_SDK_COMPAT_DIR;
it.skipIf(scratch === undefined)("real SDK matrix (not run: libraries not installed unless ROVARA_SDK_COMPAT_DIR is set)", async () => {
    const cells = await runSdkCompatibility(scratch as string, process.env.ROVARA_SDK_COMPAT_ONLY);
    expect(cells.filter(cell => cell.result === "FAIL")).toEqual([]);
}, 1800000);
