import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const preload = resolve("tests/fixtures/model-sdk-compat/sitecustomize.py");
// Removing an exact allowance kills its positive control; broadening it kills
// the refusal cases. The downstream audit hook prevents every native load,
// including when a mutant removes the guard entirely.
// macOS paths (including the bytes-name ctypes API case) belong to macOS;
// the venv boundary and refusal rules below still run on Linux.
for (const [label, expression, expected, macOnly = false] of [
    ["Security exact path", "'/System/Library/Frameworks/Security.framework/Security'", "allowed", true],
    ["CoreFoundation exact path", "'/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'", "allowed", true],
    ["explicit venv library", "os.path.join(sys.prefix,'own-library')", "allowed"],
    ["process handle", "None", "refused"],
    ["libSystem", "'/usr/lib/libSystem.B.dylib'", "refused", true],
    ["libc", "'/usr/lib/libc.dylib'", "refused", true],
    ["framework traversal", "'/System/Library/Frameworks/Security.framework/../../../usr/lib/libc.dylib'", "refused", true],
    ["Security suffix", "'/System/Library/Frameworks/Security.framework/Security-extra'", "refused", true],
    ["CoreFoundation suffix", "'/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation-extra'", "refused", true],
    ["other framework", "'/System/Library/Frameworks/Foundation.framework/Foundation'", "refused", true],
    ["relative name inside venv", "'own-library'", "refused"],
    ["bytes framework name", "b'/System/Library/Frameworks/Security.framework/Security'", "refused", true],
    ["venv symlink escape", "os.path.join(sys.prefix,'system-link')", "refused"],
    ["venv traversal", "os.path.join(sys.prefix,'..','outside-library')", "refused"],
    ["venv prefix sibling", "sys.prefix + '-other/library'", "refused"],
] as const) {
    it.skipIf(macOnly && process.platform !== "darwin")(`Python ctypes ${label} is ${expected} before native loading`, () => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "sdk-ctypes-")));
        const log = join(dir, "wire.jsonl");
        const program = `
import ctypes, os, runpy, socket, sys
sys.prefix = ${JSON.stringify(join(dir, "venv"))}
os.mkdir(sys.prefix)
os.chdir(sys.prefix)
os.symlink(os.path.join(sys.prefix, '..', 'outside-library'), 'system-link')
def no_network(*args, **kwargs):
 raise AssertionError('unexpected native connect')
socket.socket.connect = no_network
runpy.run_path(${JSON.stringify(preload)})
class NativeBoundary(Exception): pass
def stop_native_load(event, args):
 if event == 'ctypes.dlopen': raise NativeBoundary()
sys.addaudithook(stop_native_load)
try:
 ctypes.CDLL(${expression})
except NativeBoundary:
 print('allowed')
except PermissionError as error:
 assert str(error) == 'SDK_NATIVE_LIBRARY_REFUSED'
 print('refused')
else:
 raise AssertionError('native boundary not exercised')
`;
        try {
            const child = spawnSync("/usr/bin/python3", ["-I", "-c", program], {
                env: { HOME: dir, SDK_TRIPWIRE_LOG: log, SDK_PRIVATE_ROOT: join(dir, "private") },
                encoding: "utf8", timeout: 10000,
            });
            expect(child.status, child.stderr).toBe(0);
            expect(child.stdout.trim()).toBe(expected);
            expect(readFileSync(log, "utf8")).toBe('"model-canary.rovara-canary.dev"\n');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
}
