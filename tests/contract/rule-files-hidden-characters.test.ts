import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inertContextText } from "../../packages/worker/src/context-text.js";
import { devcontainerContextFile } from "../../packages/worker/src/devcontainer.js";
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
/** "ignore" spelled in Unicode tag characters (U+E0000 + ASCII), invisible in most renderers. */
const TAG_PAYLOAD = [...("ignore")].map((letter) => cp(0xe0000 + letter.charCodeAt(0))).join("");
const VARIATION_SELECTORS = cp(0xfe0f) + cp(0xe0101);
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

  it("treats CRLF line endings and a leading byte-order mark as plain text, not as hidden characters", async () => {
    const rootPath = await workspace("AGENTS.md", `${cp(0xfeff)}Line one.\r\nLine two.\r\n`);

    const { files, diagnostics } = await loadRepositoryContextFiles(rootPath, repositories);

    expect(diagnostics).toEqual([]);
    expect(files[0]!.content.endsWith("\n\nLine one.\nLine two.\n")).toBe(true);
    expect(inertContextText(`${cp(0xfeff)}a\r\nb`)).toEqual({ text: "a\nb", removed: 0 });
    // A byte-order mark anywhere else, and a lone carriage return, are still hidden characters.
    expect(inertContextText(`a${cp(0xfeff)}b`)).toEqual({ text: "ab", removed: 1 });
  });

  it("applies the cap to the bytes read: a file of exactly 64 KiB with hidden characters still loads", async () => {
    const body = "a".repeat(MAX_REPOSITORY_CONTEXT_FILE_BYTES - 3);
    const rootPath = await workspace("AGENTS.md", `${body}${ZERO_WIDTH_SPACE}`);

    const { files } = await loadRepositoryContextFiles(rootPath, repositories);

    expect(files).toHaveLength(1);
    expect(files[0]!.content.endsWith(body)).toBe(true);
  });

  it("the devcontainer note carries no hidden characters from its folders", () => {
    const content = devcontainerContextFile({
      hostFolder: `/work/repo${ZERO_WIDTH_SPACE}${TAG_PAYLOAD}`,
      containerFolder: `/workspaces/sample${RIGHT_TO_LEFT_OVERRIDE}${VARIATION_SELECTORS}`,
    }).content;
    expect(content).toContain("The repository is at /work/repo. Inside the devcontainer it is also at /workspaces/sample.");
    expect(hiddenIn(content)).toEqual([]);
  });
});
