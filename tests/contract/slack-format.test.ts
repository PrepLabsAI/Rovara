import { describe, expect, it } from "vitest";
import { slackReplyText } from "../../packages/slack-service/src/slack-format.js";

describe("Slack reply formatting", () => {

  it("shows each link once, in Slack format", () => {
    expect(slackReplyText("Created [CHA-6](https://linear.app/charterarc/issue/CHA-6).")).toBe("Created <https://linear.app/charterarc/issue/CHA-6|CHA-6>.");
    expect(slackReplyText("[<https://linear.app/x/issue/CHA-6>](<https://linear.app/x/issue/CHA-6>)")).toBe("<https://linear.app/x/issue/CHA-6>");
    expect(slackReplyText("[CHA-6](<https://linear.app/x/issue/CHA-6> \"Open in Linear\")")).toBe("<https://linear.app/x/issue/CHA-6|CHA-6>");
    expect(slackReplyText("See https://github.com/acme/app/pull/12.")).toBe("See <https://github.com/acme/app/pull/12>.");
    expect(slackReplyText("(see https://en.wikipedia.org/wiki/Fish_(disambiguation))")).toBe("(see <https://en.wikipedia.org/wiki/Fish_(disambiguation)>)");
    expect(slackReplyText("[Email us](mailto:team@example.com)")).toBe("<mailto:team@example.com|Email us>");
  });

  it("keeps links and mentions that are already in Slack format", () => {
    const text = "Thanks <@U0123456789>, see <https://slack.com/archives/C0123456789/p1|the thread> in <#C0123456789|agentx>.";
    expect(slackReplyText(text)).toBe(text);
    expect(slackReplyText("<https://example.com/a>")).toBe("<https://example.com/a>");
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

});
