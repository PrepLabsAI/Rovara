import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
const manifest = JSON.parse(await readFile(new URL("./toolchains.json", import.meta.url), "utf8"));
const entry = manifest[process.argv[2]];
if (!entry?.sha256 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("UNKNOWN_TOOL");
const actual = createHash("sha256").update(await readFile(process.argv[3])).digest("hex");
if (actual !== entry.sha256) throw new Error("DIGEST_MISMATCH");
process.stdout.write(`${process.argv[2]} verified\n`);
