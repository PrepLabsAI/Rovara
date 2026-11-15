import { readdirSync, readFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";
import { allowLoopbackOnly } from "./mutation-spot-offline.js";

it("has no production callers outside the new modules and barrel", () => {
  const allowed = new Set(["packages/contracts/src/mutation-spot.ts", "packages/contracts/src/index.ts", "packages/worker/src/verification/mutation-spot-check.ts", "packages/worker/src/verification/mutation-restore.ts"]);
  const names = [...allowed].filter((file) => !file.endsWith("index.ts")).flatMap((file) => Array.from(readFileSync(file, "utf8").matchAll(/export (?:async )?(?:function|class|const) (\w+)/gu), (match) => match[1]!));
  const found: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (["dist", "node_modules"].includes(entry.name)) continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith(".ts") && !file.endsWith(".test.ts") && !allowed.has(file)) {
        const text = readFileSync(file, "utf8");
        if (names.some((name) => new RegExp(`\\b${name}\\b`, "u").test(text))) found.push(file);
      }
    }
  };
  walk("packages"); expect(found).toEqual([]);
});
it("refuses a non-loopback socket before any connection", () => {
  const socket = new Socket();
  try { expect(() => socket.connect({ host: "203.0.113.1", port: 9 })).toThrow("forbid non-loopback sockets"); }
  finally { socket.destroy(); }
});

it("refuses string TCP ports as well as numeric ports", () => {
  expect(() => allowLoopbackOnly(["443", "203.0.113.1"])).toThrow("forbid non-loopback sockets");
});
