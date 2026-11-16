import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const fixture = resolve("tests/fixtures/model-sdk-compat");
const read = (file: string): string => readFileSync(resolve(fixture, file), "utf8");
it("pins every Python wheel exactly with a SHA-256 hash and agrees with the direct pins", () => {
    const requirements = new Map<string, string>();
    for (const line of read("requirements.txt").trim().split("\n")) {
        expect(line).toMatch(/^[a-zA-Z0-9_.-]+==[0-9][a-zA-Z0-9.+-]* --hash=sha256:[a-f0-9]{64}$/u);
        const [name, rest] = line.split("==");
        expect(requirements.has(name ?? "")).toBe(false);
        requirements.set(name ?? "", rest?.split(" ")[0] ?? "");
    }
    const pins = JSON.parse(read("pins.json")) as { python: Record<string, string> };
    for (const [name, version] of Object.entries(pins.python))
        expect(requirements.get(name)).toBe(version);
    expect(requirements.size).toBeGreaterThan(Object.keys(pins.python).length);
});

it("locks every installed npm package with integrity and exact direct versions", () => {
    const manifest = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version: string; integrity?: string; dependencies?: Record<string, string> }> };
    const pins = JSON.parse(read("pins.json")) as { node: Record<string, string> };
    expect(manifest.dependencies).toEqual(pins.node);
    expect(lock.packages[""]?.dependencies).toEqual(manifest.dependencies);
    for (const [name, version] of Object.entries(manifest.dependencies)) {
        expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u);
        expect(lock.packages[`node_modules/${name}`]?.version).toBe(version);
    }
    for (const [name, pkg] of Object.entries(lock.packages)) {
        // The root is the manifest, not a downloaded package, and has no integrity.
        if (name === "") continue;
        expect(pkg.integrity).toMatch(/^sha(?:256|384|512)-[a-zA-Z0-9+/]+=*$/u);
        expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u);
    }
});
