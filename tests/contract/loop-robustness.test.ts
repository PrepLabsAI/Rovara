// rovara loop (#390): the daemon keeps reading. A pull request is looked up in the repository it was opened in; one
// failing GitHub call fails alone, and a comment that couldn't be handled is read again; a configuration that can't be
// read is said on each running loop's issue, once, and so is the fix.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLoopHarness, LOOP_ISSUE, removeAll } from "../support/loop-harness.js";

const dirs: string[] = [];
afterEach(async () => { await removeAll(dirs); });


describe("one failing call (#390)", () => {
  it("fails alone: another loop is still read, and a comment that couldn't be handled is read again, in order", async () => {
    const h = await createLoopHarness(dirs);
    h.world.titles.set(43, "Another issue");
    // Issue 43's state can't be read; issue 42's loop is unaffected.
    h.world.say(43, "maya", "/rovara do Something else");
    await h.daemon.poll();
    h.world.failPaths = [/^repos\/acme\/payments\/issues\/43$/u];
    await h.comment("maya", "/rovara do Fix the flaky test");
    expect(await h.step()).toBe("work");

    // A comment whose handling fails is logged and counted as read; the comments after it are still read.
    h.world.failPaths = [/^repos\/acme\/payments\/issues\/42\/labels$/u];
    h.world.say(LOOP_ISSUE, "maya", "/rovara stop");
    h.world.say(LOOP_ISSUE, "sam", "A reply after it.");
    await h.daemon.poll();
    h.world.failPaths = [];
    await h.daemon.poll();
    expect(await h.step()).toBe("ended");
    // The label GitHub refused doesn't skip the rest: the session ended, and the issue was told.
    expect(h.world.posted(LOOP_ISSUE).filter((body) => body.includes("Stopped by @maya"))).toHaveLength(1);
    expect(h.world.sessions.has("rovara-acme_payments-42")).toBe(false);
  });
});

describe("a configuration that can't be read (#390)", () => {
  it("is said on each running loop's issue once, and so is the fix, after which what was said meanwhile is read", async () => {
    const h = await createLoopHarness(dirs);
    await h.comment("maya", "/rovara do Fix the flaky test");
    const config = join(h.checkout, ".rovara", "loop.yaml");
    await writeFile(config, ["version: 1", "collaborators: []", ""].join("\n"));
    await h.daemon.poll();
    await h.daemon.poll();
    const said = h.world.posted(LOOP_ISSUE).filter((body) => body.includes("can't read this repository's `.rovara/loop.yaml`"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("collaborators");
    expect(said[0]).toContain(h.checkout);

    // Meanwhile a reply; it is read once the file is fixed.
    h.world.say(LOOP_ISSUE, "maya", "Also cover the timeout.");
    await h.daemon.poll();
    await writeFile(config, ["version: 1", "collaborators: [maya, sam]", ""].join("\n"));
    await h.daemon.poll();
    expect(h.world.posted(LOOP_ISSUE).filter((body) => body.includes("reads again"))).toHaveLength(1);
    expect(h.lastReceived()).toContain("Also cover the timeout.");
  });

});
