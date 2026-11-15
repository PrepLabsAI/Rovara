import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { parseSdkResult } from "../support/model-sdk-compat-policy.js";

it("reports the installed Node package version even when pins claim a different version", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-compat-"));
    const fixture = resolve("tests/fixtures/model-sdk-compat");
    try {
        mkdirSync(join(dir, "node_modules/openai"), { recursive: true });
        // An offline stand-in, not an installed SDK: no network or package manager.
        writeFileSync(join(dir, "node_modules/openai/package.json"), JSON.stringify({ name: "openai", version: "1.2.3", type: "module", exports: "./index.mjs" }));
        writeFileSync(join(dir, "node_modules/openai/index.mjs"), "export default class OpenAI { chat={completions:{create:async()=>({choices:[{finish_reason:'stop',message:{content:'text'}}],usage:{}})}}; }");
        writeFileSync(join(dir, "pins.json"), JSON.stringify({ node: { openai: "9.9.9" } }));
        writeFileSync(join(dir, "wire.jsonl"), "");
        for (const file of ["node-client.mjs", "tripwire.mjs"])
            copyFileSync(join(fixture, `${file}.fixture`), join(dir, file));
        const child = spawnSync(process.execPath, ["--import", join(dir, "tripwire.mjs"), join(dir, "node-client.mjs")], { env: { HOME: dir, LIBRARY: "openai", SCENARIO: "text", BASE_URL: "http://127.0.0.1:1", SDK_TRIPWIRE_LOG: join(dir, "wire.jsonl") }, encoding: "utf8", timeout: 10000 });
        expect(child.status, child.stderr).toBe(0);
        expect(parseSdkResult(child.stdout).version).toBe("1.2.3");
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
