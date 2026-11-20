// Q3: when a question (or a page button, a run link) waits and no page has been connected for a
// minute, the terminal says once where to reopen the page. A page that reconnects, or stays open,
// gets no reminder.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_CLOSED_MS, pageClosedLine, pageClosedReminder, startInstallWizard } from "../../packages/cli/src/init/ui/index.js";
import { browserPrompter } from "../../packages/cli/src/init/ui/prompter.js";
import { createWizardHub, type WizardListener } from "../../packages/cli/src/init/ui/state.js";

const URL = "http://127.0.0.1:51234/?t=token";
const quiet: WizardListener = { state: () => undefined, log: () => undefined, closed: () => undefined };

function setup() {
  let clock = 0;
  const lines: string[] = [];
  const hub = createWizardHub("staging");
  const reminder = pageClosedReminder({ hub, url: URL, write: (line) => { lines.push(line); }, now: () => clock });
  return { hub, lines, reminder, advance: (ms: number) => { clock += ms; reminder.check(); } };
}

describe("the closed-tab reminder", () => {

  it("reminds at the next check when a question arrives after the page has been closed for 2 minutes", () => {
    const { hub, lines, advance } = setup();
    advance(PAGE_CLOSED_MS * 2);
    expect(lines).toEqual([]);
    void browserPrompter(hub).ask("Alert email address", { flag: "--alert-email" });
    advance(5_000);
    expect(lines).toEqual([pageClosedLine(URL)]);
  });

  it("says once where to reopen the page when the run waits on a page button (a link, no question) with no page for a minute", () => {
    const { hub, lines, advance } = setup();
    hub.showLink({ url: "https://github.com/settings/apps/new", label: "Create the GitHub App" });
    expect(hub.state().question).toBeUndefined();
    advance(PAGE_CLOSED_MS - 1);
    expect(lines).toEqual([]);
    advance(1);
    expect(lines).toEqual([pageClosedLine(URL)]);
    advance(PAGE_CLOSED_MS * 5);
    expect(lines).toHaveLength(1);
  });

  it("no reminder for a page button (a link, no question) while a page is connected", () => {
    const { hub, lines, advance } = setup();
    hub.subscribe(quiet);
    hub.showLink({ url: "https://github.com/settings/apps/new", label: "Create the GitHub App" });
    advance(PAGE_CLOSED_MS * 10);
    expect(lines).toEqual([]);
  });

});

describe("the reminder timer in startInstallWizard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the line with the wizard's own address once, and nothing after close", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const lines: string[] = [];
    const wizard = await startInstallWizard({ env: "staging", write: (line) => { lines.push(line); } });
    try {
      const before = lines.length;
      void wizard.prompter.ask("Alert email address", { flag: "--alert-email" }).catch(() => undefined);
      vi.advanceTimersByTime(65_000);
      expect(lines.slice(before)).toEqual([pageClosedLine(wizard.url)]);
      await wizard.close();
      vi.advanceTimersByTime(PAGE_CLOSED_MS * 5);
      expect(lines.slice(before)).toEqual([pageClosedLine(wizard.url)]);
    } finally {
      await wizard.close();
    }
  });
});
