import { describe, expect, it } from "vitest";
import { slackReplyText } from "../../packages/slack-service/src/slack-format.js";

describe("Slack reply formatting", () => {
  it("leaves plain text as it is", () => {
    expect(slackReplyText("Fixed the navigation bug.")).toBe("Fixed the navigation bug.");
    expect(slackReplyText("Line one\nLine two")).toBe("Line one\nLine two");
  });

  it("turns literal \\n sequences into line breaks only when there are no real newlines", () => {
    expect(slackReplyText("Created CHA-6.\\nAssigned to Pratik.\\r\\nDone.")).toBe("Created CHA-6.\nAssigned to Pratik.\nDone.");
    expect(slackReplyText("Use \\\\n to split lines.")).toBe("Use \\\\n to split lines.");
    expect(slackReplyText("Open C:\\Users\\nick\\notes.txt\nNext line")).toBe("Open C:\\Users\\nick\\notes.txt\nNext line");
    expect(slackReplyText("line one\\nline two")).toBe("line one\nline two");
  });

  it("shows each link once, in Slack format", () => {
    expect(slackReplyText("Created [CHA-6](https://linear.app/charterarc/issue/CHA-6).")).toBe("Created <https://linear.app/charterarc/issue/CHA-6|CHA-6>.");
    expect(slackReplyText("[<https://linear.app/x/issue/CHA-6>](<https://linear.app/x/issue/CHA-6>)")).toBe("<https://linear.app/x/issue/CHA-6>");
    expect(slackReplyText("[CHA-6](<https://linear.app/x/issue/CHA-6> \"Open in Linear\")")).toBe("<https://linear.app/x/issue/CHA-6|CHA-6>");
    expect(slackReplyText("See https://github.com/acme/app/pull/12.")).toBe("See <https://github.com/acme/app/pull/12>.");
    expect(slackReplyText("(see https://en.wikipedia.org/wiki/Fish_(disambiguation))")).toBe("(see <https://en.wikipedia.org/wiki/Fish_(disambiguation)>)");
    expect(slackReplyText("[Email us](mailto:team@example.com)")).toBe("<mailto:team@example.com|Email us>");
  });

  it("allows one level of nested brackets in markdown link labels", () => {
    expect(slackReplyText("[a [b] c](https://example.com)")).toBe("<https://example.com|a [b] c>");
  });

  it("does not let a nested bracket in a link label span a real newline (M6)", () => {
    // Slack does not render a link token that spans lines, so a newline inside the nested brackets
    // must stop the label from being recognised as a single Markdown link: the brackets stay literal
    // text (with the real newline they had) and the bare URL is linked on its own.
    expect(slackReplyText("[a [b\nc] d](https://x.com)")).toBe("[a [b\nc] d](<https://x.com>)");
  });

  it("keeps links and mentions that are already in Slack format", () => {
    const text = "Thanks <@U0123456789>, see <https://slack.com/archives/C0123456789/p1|the thread> in <#C0123456789|agentx>.";
    expect(slackReplyText(text)).toBe(text);
    expect(slackReplyText("<https://example.com/a>")).toBe("<https://example.com/a>");
  });

  it("rebuilds an already-Slack-formatted URL token through link() so & is encoded consistently (M7)", () => {
    expect(slackReplyText("<https://a.com?x=1&y=2|lbl & co>")).toBe("<https://a.com?x=1&amp;y=2|lbl &amp; co>");
    expect(slackReplyText("<https://a.com?x=1&y=2>")).toBe("<https://a.com?x=1&amp;y=2>");
    // Non-URL tokens (user/channel mentions) are kept exactly as they were, not rebuilt.
    expect(slackReplyText("<@U0123456789>")).toBe("<@U0123456789>");
    expect(slackReplyText("<#C0123456789|agentx>")).toBe("<#C0123456789|agentx>");
    // <!channel> and <!here> are not a recognised token, so they are still escaped, never sent live.
    expect(slackReplyText("<!channel>")).toBe("&lt;!channel&gt;");
    expect(slackReplyText("<!here|here>")).toBe("&lt;!here|here&gt;");
  });

  it("encodes | and ends a URL at a raw > so a link cannot be split or closed early", () => {
    expect(slackReplyText("[query](https://example.com/search?q=a|b&x=1)")).toBe("<https://example.com/search?q=a%7Cb&amp;x=1|query>");
    expect(slackReplyText("https://example.com/a|b")).toBe("<https://example.com/a%7Cb>");
    expect(slackReplyText("https://example.com/a>b")).toBe("<https://example.com/a>&gt;b");
    expect(slackReplyText("[a > b | c](https://example.com/)")).toBe("<https://example.com/|a &gt; b | c>");
  });

  it("handles very long URLs with many trailing parentheses efficiently", () => {
    const result = slackReplyText("See https://example.com/status" + ")".repeat(200000) + " ok");
    expect(result).toBe("See <https://example.com/status>" + ")".repeat(200000) + " ok");
  });

  it("never lets reply text notify a channel, and escapes stray control characters", () => {
    expect(slackReplyText("<!channel> the build is broken & <!here>")).toBe("&lt;!channel&gt; the build is broken &amp; &lt;!here&gt;");
    expect(slackReplyText("if a < b && b > c")).toBe("if a &lt; b &amp;&amp; b &gt; c");
    expect(slackReplyText("Already escaped: &lt;div&gt; &amp; more")).toBe("Already escaped: &lt;div&gt; &amp; more");
  });

  it("does not change the content of code spans or fenced blocks", () => {
    expect(slackReplyText("Run `printf \"a\\nb\" | wc -l` then **stop**.")).toBe("Run `printf \"a\\nb\" | wc -l` then *stop*.");
    const block = "```ts\nconst url = \"[x](https://example.com)\";\nconsole.log(\"**not bold**\\n\");\nif (a < b && c > d) {}\n```";
    expect(slackReplyText(`Here:\n${block}\nDone.`)).toBe(
      "Here:\n```\nconst url = \"[x](https://example.com)\";\nconsole.log(\"**not bold**\\n\");\nif (a &lt; b &amp;&amp; c &gt; d) {}\n```\nDone.",
    );
    expect(slackReplyText("Unclosed:\n```\nhttps://example.com/a\\n")).toBe("Unclosed:\n```\nhttps://example.com/a\\n");
    expect(slackReplyText("a `lone backtick\\nhere")).toBe("a `lone backtick\nhere");
  });

  it("turns Markdown bold and headings into Slack bold and keeps quote markers", () => {
    expect(slackReplyText("## Summary\n**Created** CHA-6")).toBe("*Summary*\n*Created* CHA-6");
    expect(slackReplyText("# **Result** #")).toBe("*Result*");
    expect(slackReplyText("> quoted line\nnot > quoted")).toBe("> quoted line\nnot &gt; quoted");
    expect(slackReplyText("**https://example.com/x**")).toBe("*<https://example.com/x>*");
  });

  it("bounds markdown link label parsing to prevent quadratic regex backtracking", () => {
    const unclosedBrackets = "[".repeat(100000) + "x";
    const result = slackReplyText(unclosedBrackets);
    expect(result).toContain("x");
  });

  it("bounds nested bracket parsing to prevent quadratic regex backtracking", () => {
    const nestedBrackets = "[a [b ".repeat(40000);
    const result = slackReplyText(nestedBrackets);
    expect(result).toContain("[");
  });

  it("handles long heading lines efficiently", () => {
    const longHeading = "# " + "a".repeat(100000);
    const result = slackReplyText(longHeading);
    expect(result).toContain("*");
  });

  it("handles long lines with many bold markers efficiently", () => {
    const manyBold = "**a**".repeat(40000);
    const result = slackReplyText(manyBold);
    expect(result).toContain("*");
  });

  it("handles bare URLs with many slashes efficiently", () => {
    const longUrl = "https://" + "a/".repeat(50000);
    const result = slackReplyText(longUrl);
    expect(result).toContain("<https");
  });
});
