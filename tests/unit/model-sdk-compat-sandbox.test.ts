// 9d runs these on macOS outside Codex's nested sandbox. No downloaded SDKs.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sdkSandboxInvocation } from "../support/model-sdk-compat-policy.js";
import { runSdkChild } from "../support/model-sdk-compat-runner.js";

describe.skipIf(process.env.ROVARA_SANDBOX_TESTS !== "1")("real macOS SDK sandbox (requires ROVARA_SANDBOX_TESTS=1)", () => {
    it("applies the exact runner profile before executing a child", async () => {
        expect(process.platform).toBe("darwin");
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "sdk-compat-")));
        try {
            const invocation = sdkSandboxInvocation("/usr/bin/true", [], { privateHome: join(dir, "private"), runtime: "/usr/bin", scratch: dir });
            const child = await runSdkChild(invocation.command, invocation.args, {}, dir, 5000);
            expect(child).toEqual({ code: 0, timedOut: false, stdout: "" });
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it("allows a real loopback connection while refusing external TCP/UDP and private files without language hooks", async () => {
        expect(process.platform).toBe("darwin");
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "sdk-compat-")));
        const server = createServer(socket => socket.end());
        try {
            mkdirSync(join(dir, "private")); mkdirSync(join(dir, "scratch"));
            writeFileSync(join(dir, "private/sentinel"), "private-canary");
            await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
            const address = server.address();
            if (address === null || typeof address === "string") throw new Error("missing loopback listener");
            const program = `
import net from 'node:net'; import dgram from 'node:dgram'; import {readFileSync} from 'node:fs';
await new Promise((resolve,reject)=>{const s=net.connect(${String(address.port)},'127.0.0.1',()=>{s.destroy();resolve();});s.on('error',reject);});
await new Promise((resolve,reject)=>{const s=net.connect(9,'192.0.2.1',()=>reject(new Error('escaped')));s.on('error',e=>{s.destroy();['EPERM','EACCES'].includes(e.code)?resolve():reject(new Error('wrong-refusal'));});});
await new Promise((resolve,reject)=>{const s=dgram.createSocket('udp4');s.send('canary',9,'192.0.2.1',e=>{s.close();e&&['EPERM','EACCES'].includes(e.code)?resolve():reject(new Error('escaped'));});});
try{readFileSync(${JSON.stringify(join(dir, "private/sentinel"))});throw new Error('file-escaped');}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;}
console.log('loopback-ok;external-refused;private-refused');`;
            const invocation = sdkSandboxInvocation(process.execPath, ["--input-type=module", "-e", program], { privateHome: join(dir, "private"), runtime: dirname(dirname(realpathSync(process.execPath))), scratch: join(dir, "scratch") });
            const child = await runSdkChild(invocation.command, invocation.args, {}, dir, 5000);
            expect(child).toEqual({ code: 0, timedOut: false, stdout: "loopback-ok;external-refused;private-refused\n" });
        } finally {
            await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
