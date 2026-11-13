import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
const fixture = resolve("tests/fixtures/model-sdk-compat");
for (const [door, call, allowed] of [
    ["sendto", "_socket.socket(type=socket.SOCK_DGRAM).sendto(b'canary',('192.0.2.1',9))", "sys.audit('socket.sendto',None,('127.0.0.1',9))"],
    ["sendmsg", "_socket.socket(type=socket.SOCK_DGRAM).sendmsg([b'canary'],[],0,('192.0.2.1',9))", "sys.audit('socket.sendmsg',None,('::1',9))"],
    ["getnameinfo", "_socket.getnameinfo(('192.0.2.1',9),0)", "sys.audit('socket.getnameinfo',('localhost',9))"],
    ["ctypes", "ctypes.CDLL(None)", "sys.audit('ctypes.dlopen',os.path.join(sys.prefix,'own-library'))"],
    ["ctypes outside venv", "ctypes.CDLL('/outside/lib-canary')", "sys.audit('ctypes.dlopen',os.path.join(sys.prefix,'own-library'))"],
    ["ctypes relative path", "ctypes.CDLL('lib-canary')", "sys.audit('ctypes.dlopen',os.path.join(sys.prefix,'own-library'))"],
] as const) {
    it(`Python audits native ${door} before a system call and permits the narrow allowed case`, () => {
        const dir = mkdtempSync(join(tmpdir(), "sdk-compat-"));
        const log = join(dir, "wire.jsonl");
        writeFileSync(log, "");
        const program = `
import socket, _socket, ctypes, runpy, os, sys
sys.prefix = ${JSON.stringify(join(dir, "venv"))}
runpy.run_path(${JSON.stringify(join(fixture, "sitecustomize.py"))})
${allowed}
# Last audit hook is an inert backstop: a missing guard cannot send a packet.
def inert(event,args):
 if event in ('socket.sendto','socket.sendmsg','socket.getnameinfo','ctypes.dlopen'): raise RuntimeError('unguarded')
sys.addaudithook(inert)
try: ${call}
except PermissionError: pass
else: raise AssertionError('guard absent')
`;
        try {
            const child = spawnSync("/usr/bin/python3", ["-I", "-c", program], { env: { HOME: dir, SDK_TRIPWIRE_LOG: log, SDK_PRIVATE_ROOT: join(dir, "private") }, encoding: "utf8", timeout: 10000 });
            expect(child.status, child.stderr).toBe(0);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
}
it("both preloads prove one canary refusal before loading an SDK", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-compat-"));
    const log = join(dir, "wire.jsonl");
    writeFileSync(join(dir, "tripwire.mjs"), readFileSync(join(fixture, "tripwire.mjs.fixture")));
    try {
        const programs = [
            { command: "/usr/bin/python3", args: ["-I", "-c", `import socket,runpy\ndef inert(*a,**k): raise RuntimeError('unguarded')\nsocket.socket.connect=inert\nrunpy.run_path(${JSON.stringify(join(fixture, "sitecustomize.py"))})`] },
            { command: process.execPath, args: ["--input-type=module", "-e", `import net from 'node:net';net.Socket.prototype.connect=()=>{throw new Error('unguarded')};await import(${JSON.stringify(pathToFileURL(join(dir, "tripwire.mjs")).href)});`] },
        ];
        for (const program of programs) {
            writeFileSync(log, "");
            const child = spawnSync(program.command, program.args, { env: { HOME: dir, SDK_TRIPWIRE_LOG: log, SDK_PRIVATE_ROOT: join(dir, "private") }, encoding: "utf8", timeout: 10000 });
            expect(child.status, child.stderr).toBe(0);
            expect(readFileSync(log, "utf8")).toBe('"model-canary.rovara-canary.dev"\n');
        }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
describe("SDK subprocess tripwires", () => {
    it("refuses every Node network door before its native implementation and records only the host", () => {
        const dir = mkdtempSync(join(tmpdir(), "sdk-wire-"));
        const log = join(dir, "wire.jsonl");
        writeFileSync(log, "");
        writeFileSync(join(dir, "tripwire.mjs"), readFileSync(join(fixture, "tripwire.mjs.fixture")));
        const program = `
      import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns';
      import http from 'node:http'; import https from 'node:https'; import http2 from 'node:http2';
      import dgram from 'node:dgram';
      const inert = () => { throw new Error('unguarded'); };
      net.Socket.prototype.connect = inert; tls.connect = inert;
      dns.lookup = inert; dns.promises.lookup = inert; dns.resolve4 = inert;
      http.request = inert; http.get = inert; https.request = inert; https.get = inert;
      http2.connect = inert; globalThis.fetch = inert; globalThis.WebSocket = class { constructor() { inert(); } };
      dgram.Socket.prototype.send = inert; dgram.Socket.prototype.connect = inert;
      const dnsDoors=[];
      for(const object of [dns,dns.promises,dns.Resolver.prototype,dns.promises.Resolver.prototype])for(const key of ['lookupService','resolve','resolve6','resolveAny','resolveCname','resolveMx','resolveNs','resolveSrv','resolveTxt','resolvePtr','resolveNaptr','resolveSoa','resolveCaa','reverse'])if(typeof object[key]==='function'){object[key]=inert;dnsDoors.push(()=>object[key]('model-canary.rovara-canary.dev'));}
      await import(${JSON.stringify(pathToFileURL(join(dir, "tripwire.mjs")).href)});
      const host = 'model-canary.rovara-canary.dev';
      const calls = [() => net.connect(443,host), () => tls.connect({host,port:443}),
        () => dns.lookup(host,()=>{}), () => dns.promises.lookup(host), () => dns.resolve4(host,()=>{}),
        () => http.request('http://'+host), () => https.request('https://'+host),
        () => http.get('http://'+host), () => https.get('https://'+host),
        () => http2.connect('https://'+host), () => fetch('https://'+host), () => new WebSocket('wss://'+host)];
      const udp=dgram.createSocket('udp4'); calls.push(()=>udp.connect(443,host),()=>udp.send('canary',443,host),...dnsDoors);
      for (const call of calls) { let caught = false; try { await call(); } catch(e) { caught = e.code === 'SDK_EGRESS_REFUSED'; } if (!caught) process.exit(3); }
      udp.close(); console.log(calls.length);
    `;
        try {
            const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { env: { HOME: dir, SDK_TRIPWIRE_LOG: log }, encoding: "utf8", timeout: 10000 });
            expect(result.status, result.stderr).toBe(0);
            expect(Number(result.stdout.trim())).toBeGreaterThan(12);
            expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(Array.from({ length: Number(result.stdout.trim()) + 1 }, () => JSON.stringify("model-canary.rovara-canary.dev")));
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("Python refuses native connect and DNS doors and denies private-home reads", () => {
        const dir = mkdtempSync(join(tmpdir(), "sdk-pywire-"));
        const log = join(dir, "wire.jsonl");
        writeFileSync(log, "");
        const secret = join(dir, "private", "sentinel");
        const program = `
import socket, ssl, runpy, os, sys
class Unguarded(Exception): pass
def inert(*a, **kw): raise Unguarded()
socket.socket.connect = inert
socket.socket.connect_ex = inert
socket.create_connection = inert
socket.getaddrinfo = inert
socket.gethostbyname = inert
socket.gethostbyname_ex = inert
socket.gethostbyaddr = inert
socket.socket.sendto = inert
ssl.SSLContext.wrap_socket = inert
runpy.run_path(${JSON.stringify(join(fixture, "sitecustomize.py"))})
host = 'model-canary.rovara-canary.dev'
for call in [lambda: socket.socket().connect((host,443)), lambda: socket.socket().connect_ex((host,443)), lambda: socket.create_connection((host,443)), lambda: socket.getaddrinfo(host,443), lambda: socket.gethostbyname(host), lambda: socket.gethostbyname_ex(host), lambda: socket.gethostbyaddr(host), lambda: socket.socket().sendto(b'canary',(host,443)), lambda: sys.audit('socket.connect',None,(host,443)), lambda: sys.audit('socket.getaddrinfo',host,443), lambda: ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT).wrap_socket(socket.socket(),server_hostname=host)]:
 try: call()
 except PermissionError: pass
 else: raise AssertionError('guard absent')
try: open(${JSON.stringify(secret)},'w')
except PermissionError: pass
else: raise AssertionError('private home not denied')
try: sys.audit('subprocess.Popen',None)
except PermissionError: pass
else: raise AssertionError('subprocess not denied')
`;
        try {
            const child = spawnSync("/usr/bin/python3", ["-I", "-c", program], { env: { HOME: dir, SDK_TRIPWIRE_LOG: log, SDK_PRIVATE_ROOT: join(dir, "private") }, encoding: "utf8", timeout: 10000 });
            expect(child.status, child.stderr).toBe(0);
            expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(12);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
it("the runner's Node permission arguments deny files outside the scratch client and empty home", async () => {
    const { sdkNodeArguments } = await import("../support/model-sdk-compat-policy.js");
    const { mkdirSync } = await import("node:fs");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sdk-files-")));
    try {
        const client = join(dir, "node");
        mkdirSync(client);
        const log = join(dir, "wire.jsonl");
        writeFileSync(log, "");
        const marker = join(dir, "private-sentinel");
        writeFileSync(marker, "private-canary");
        writeFileSync(join(client, "tripwire.mjs"), "");
        writeFileSync(join(client, "read.mjs"), `import {readFileSync} from 'node:fs';try{readFileSync(${JSON.stringify(marker)});process.exitCode=3;}catch(e){if(e.code!=='ERR_ACCESS_DENIED')throw e;}`);
        const child = spawnSync(process.execPath, sdkNodeArguments({ directory: client, log, home: join(dir, "home"), config: join(dir, "config"), file: "read.mjs" }), { env: { HOME: join(dir, "home") }, encoding: "utf8", timeout: 10000 });
        expect(child.status, child.stderr).toBe(0);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
