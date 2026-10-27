import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inertContextText } from "../../packages/worker/src/context-text.js";
import {
  loadRepositoryContextFiles,
  MAX_REPOSITORY_CONTEXT_FILE_BYTES,
} from "../../packages/worker/src/repository-context.js";

// A4: a repository's rule file is untrusted text that goes to the model. Characters a reader cannot
// see (zero-width, bidi controls, Unicode tag characters, variation selectors) are removed once, where
// the file is loaded. The payloads are built from code points so this file holds no invisible characters.
const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const ZERO_WIDTH_SPACE = cp(0x200b);
const RIGHT_TO_LEFT_OVERRIDE = cp(0x202e);
const POP_DIRECTIONAL = cp(0x202c);
/** "ignore" spelled in Unicode tag characters (U+E0000 + ASCII), invisible in most renderers. */
const TAG_PAYLOAD = [...("ignore")].map((letter) => cp(0xe0000 + letter.charCodeAt(0))).join("");
const VARIATION_SELECTORS = cp(0xfe0f) + cp(0xe0101);
/** Default-ignorable and private-use code points that are neither \p{Cf} nor control characters, and render as nothing. */
const OTHER_INVISIBLES = [0x034f, 0x115f, 0x1160, 0x3164, 0xffa0, 0x17b4, 0x17b5, 0x180b, 0x180c, 0x180d, 0x180f, 0xe000, 0xf0000].map((code) => cp(code));
const HIDDEN = new RegExp("[\\p{Cf}\\p{Cc}\\p{Co}\\p{Cn}\\p{Cs}\\p{Default_Ignorable_Code_Point}\\u{FE00}-\\u{FE0F}\\u{E0100}-\\u{E01EF}]", "gu");
const hiddenIn = (text: string) => [...text.replace(/[\n\t]/g, "")].filter((char) => char.match(HIDDEN) !== null);

const repositories = [{ name: "api", path: "repo/api" }];

async function workspace(ruleFile: string, content: string): Promise<string> {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), "agentx-hidden-")));
  await mkdir(join(rootPath, "repo/api"), { recursive: true });
  await writeFile(join(rootPath, "repo/api", ruleFile), content);
  return rootPath;
}

describe("hidden characters in a repository's rule file (A4)", () => {
  it("removes zero-width, bidi, tag and variation-selector characters and keeps the visible words", async () => {
    const hidden = [ZERO_WIDTH_SPACE, RIGHT_TO_LEFT_OVERRIDE, POP_DIRECTIONAL, TAG_PAYLOAD, VARIATION_SELECTORS, cp(0x07), ...OTHER_INVISIBLES];
    const rootPath = await workspace(
      "AGENTS.md",
      `Run the te${ZERO_WIDTH_SPACE}sts before a PR.\n${RIGHT_TO_LEFT_OVERRIDE}Never skip lint${POP_DIRECTIONAL}.\nPlain${TAG_PAYLOAD}${VARIATION_SELECTORS} text${cp(0x07)}.\nMore${OTHER_INVISIBLES.join("")} words.\n`,
    );

    const { files } = await loadRepositoryContextFiles(rootPath, repositories);

    expect(files).toHaveLength(1);
    const content = files[0]!.content;
    expect(content).toContain("Run the tests before a PR.\nNever skip lint.\nPlain text.\nMore words.\n");
    for (const part of hidden) expect(content).not.toContain(part);
    expect(hiddenIn(content)).toEqual([]);
  });

  it("removes every invisible default-ignorable and private-use code point on its own, and says how many", async () => {
    for (const invisible of OTHER_INVISIBLES) {
      const rootPath = await workspace("AGENTS.md", `Keep${invisible}going.\n`);
      const { files, diagnostics } = await loadRepositoryContextFiles(rootPath, repositories);
      expect(files[0]!.content, `U+${invisible.codePointAt(0)!.toString(16)}`).toContain("Keepgoing.");
      expect(diagnostics).toEqual(["removed 1 hidden characters from AGENTS.md of api"]);
    }
  });

  it("treats CRLF line endings and a leading byte-order mark as plain text, not as hidden characters", async () => {
    const rootPath = await workspace("AGENTS.md", `${cp(0xfeff)}Line one.\r\nLine two.\r\n`);

    const { files, diagnostics } = await loadRepositoryContextFiles(rootPath, repositories);

    expect(diagnostics).toEqual([]);
    expect(files[0]!.content.endsWith("\n\nLine one.\nLine two.\n")).toBe(true);
    expect(inertContextText(`${cp(0xfeff)}a\r\nb`)).toEqual({ text: "a\nb", removed: 0 });
    // A byte-order mark anywhere else, and a lone carriage return, are still hidden characters.
    expect(inertContextText(`a${cp(0xfeff)}b\rc`)).toEqual({ text: "abc", removed: 2 });
  });

  it("keeps newlines and tabs, and leaves ordinary non-English text and emoji unchanged", async () => {
    const text = "Use tabs:\n\tindented line\nCafé résumé naïve, 日本語のテスト, Привет, مرحبا 🚀 ✅\n";
    const rootPath = await workspace("AGENTS.md", text);

    const { files, diagnostics } = await loadRepositoryContextFiles(rootPath, repositories);

    expect(diagnostics).toEqual([]);
    expect(files[0]?.content.endsWith(`\n\n${text}`)).toBe(true);
  });

  it("still skips a file over 64 KiB with the existing diagnostic (cap unchanged)", async () => {
    const rootPath = await workspace("AGENTS.md", "a".repeat(MAX_REPOSITORY_CONTEXT_FILE_BYTES + 1));

    const { files, diagnostics } = await loadRepositoryContextFiles(rootPath, repositories);

    expect(files).toEqual([]);
    expect(diagnostics).toEqual(["skipped repo/api/AGENTS.md: 65537 bytes exceeds the 65536-byte limit"]);
  });

  it("applies the cap to the bytes read: a file of exactly 64 KiB with hidden characters still loads", async () => {
    const body = "a".repeat(MAX_REPOSITORY_CONTEXT_FILE_BYTES - 3);
    const rootPath = await workspace("AGENTS.md", `${body}${ZERO_WIDTH_SPACE}`);

    const { files } = await loadRepositoryContextFiles(rootPath, repositories);

    expect(files).toHaveLength(1);
    expect(files[0]!.content.endsWith(body)).toBe(true);
  });

  it("says how many characters were removed, from which file and repository, and never what they were", async () => {
    const payload = `${ZERO_WIDTH_SPACE}${RIGHT_TO_LEFT_OVERRIDE}${TAG_PAYLOAD}${VARIATION_SELECTORS}`;
    const removed = [...payload].length;
    expect(removed).toBe(10);
    const rootPath = await workspace("CLAUDE.md", `Check${payload} the build.\n`);

    const { files, diagnostics } = await loadRepositoryContextFiles(rootPath, repositories);

    expect(files).toHaveLength(1);
    expect(files[0]!.content).toContain("Check the build.");
    expect(diagnostics).toEqual([`removed ${removed} hidden characters from CLAUDE.md of api`]);
    expect(hiddenIn(diagnostics.join("\n"))).toEqual([]);
  });

  it("gives no diagnostic when nothing was removed", async () => {
    const rootPath = await workspace("AGENTS.md", "Plain rules.\n");

    const { diagnostics } = await loadRepositoryContextFiles(rootPath, repositories);

    expect(diagnostics).toEqual([]);
  });

  it("inertContextText reports the removed count and keeps \\n and \\t but drops other controls", () => {
    expect(inertContextText(`a\tb\nc${cp(0x00)}${cp(0x1b)}${cp(0x0d)}${cp(0xfeff)}${cp(0xad)}d`)).toEqual({ text: "a\tb\ncd", removed: 5 });
    expect(inertContextText("")).toEqual({ text: "", removed: 0 });
  });
});
