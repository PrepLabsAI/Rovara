// Lane L8: the `sessions` and `session *` commands. main.ts calls `registerSessionCommands` once; everything the commands need from it comes in as `context`.
import { INTENT_QUESTIONS_MAX } from "@rovara-code/contracts";
import type { Command } from "commander";
import type { DeveloperSessionDeps } from "../developer/session.js";
import { formatSuccess } from "../output.js";
import type { AppResult } from "./app-request.js";
import { sessionAnswer, sessionControl, sessionFollow, sessionSay, sessionShare, sessionShow, sessionStart, sessionTakeOver, sessionsList } from "./commands.js";

export interface SessionCommandContext {
  developerSession: () => DeveloperSessionDeps;
  /** The `--env` the person typed, or undefined for the default sign-in. */
  developerEnv: (command: Command) => string | undefined;
  /** The global options (`--json`, `--project`). */
  globalOptions: (command: Command) => { json: boolean; project?: string | undefined };
  write: (text: string) => void;
}

export function registerSessionCommands(program: Command, context: SessionCommandContext): void {
  const { developerSession, developerEnv, globalOptions } = context;
  const printResult = (command: Command, result: AppResult) => {
    context.write(globalOptions(command).json ? formatSuccess({ env: result.env, url: result.url, ...result.data }, true) : result.text);
  };
  program
    .command("sessions")
    .description("list sessions: yours by default, those shared with you, or a project's")
    .option("--mine", "sessions you own (the default)", false)
    .option("--shared", "sessions shared with you", false)
    .option("--project <name>", "a project's sessions")
    .option("--cursor <cursor>", "continue a list from the cursor it printed")
    .action(async (options: { mine: boolean; shared: boolean; project?: string; cursor?: string }, command: Command) => {
      const project = options.project ?? globalOptions(command).project;
      printResult(command, await sessionsList(developerSession(), developerEnv(command), {
        mine: options.mine, shared: options.shared, ...(project === undefined ? {} : { project }), ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      }));
    });
  const session = program.command("session").description("start work, look at one session, comment on it, tell its agent, answer its questions, stop it, retry it, take it over or share it");
  session
    .command("start")
    .description("start Rovara Code on a project with your instructions, and print the link to its page")
    .argument("<instructions>", "complete instructions for Rovara; the worker gets them exactly as written")
    .option("--project <name>", "the project's exact name")
    .option("--title <title>", "a short title, at most 120 characters")
    .option("--workflow <path>", "quick or full: the plan-first workflow, where you approve the plan before any code is written")
    .action(async (instructions: string, options: { project?: string; title?: string; workflow?: string }, command: Command) =>
      printResult(command, await sessionStart(developerSession(), developerEnv(command), { project: options.project ?? globalOptions(command).project, instructions, ...(options.title === undefined ? {} : { title: options.title }), ...(options.workflow === undefined ? {} : { workflow: options.workflow }) })));
  session
    .command("show")
    .description("show a session: its link, status, owner, cost and what waits for you")
    .argument("<session-id>", "the session's ID, from agentx sessions")
    .action(async (id: string, _options: unknown, command: Command) => printResult(command, await sessionShow(developerSession(), developerEnv(command), id)));
  for (const follow of [true, false]) {
    session
      .command(follow ? "follow" : "unfollow")
      .description(follow ? "follow a session: you are told when it needs you" : "stop following a session")
      .argument("<session-id>", "the session's ID")
      .action(async (id: string, _options: unknown, command: Command) => printResult(command, await sessionFollow(developerSession(), developerEnv(command), id, follow)));
  }
  session
    .command("comment")
    .description("write a comment on a session, for the people on it (the agent does not read it)")
    .argument("<session-id>", "the session's ID")
    .argument("<text>", "the comment")
    .action(async (id: string, text: string, _options: unknown, command: Command) => printResult(command, await sessionSay(developerSession(), developerEnv(command), id, "comment", text)));
  session
    .command("tell")
    .description("send a message to the session's agent; it needs \"can use\" on the session. To answer Rovara's questions use session answer")
    .argument("<session-id>", "the session's ID")
    .argument("<text>", "the message")
    .action(async (id: string, text: string, _options: unknown, command: Command) => printResult(command, await sessionSay(developerSession(), developerEnv(command), id, "steer", text)));
  const answerCommand = session
    .command("answer")
    .description("answer the questions Rovara Code asked before it plans; with no --qN it shows the questions. It needs \"can use\" on the session")
    .argument("<task-or-session>", "the session's ID (from agentx sessions) or the task's ID");
  for (let number = 1; number <= INTENT_QUESTIONS_MAX; number += 1) answerCommand.option(`--q${number} <answer>`, `the answer to question ${number}: an option's letter or words, or your own words ("your call" leaves it to Rovara)`);
  answerCommand.action(async (ref: string, options: Record<string, string | undefined>, command: Command) =>
    printResult(command, await sessionAnswer(developerSession(), developerEnv(command), ref, { answers: Array.from({ length: INTENT_QUESTIONS_MAX }, (_unused, index) => options[`q${index + 1}`]) })));
  for (const action of ["stop", "retry"] as const) {
    session
      .command(action)
      .description(action === "stop" ? "stop a session's work; the session stays open" : "retry a session that failed or was cancelled")
      .argument("<session-id>", "the session's ID")
      .action(async (id: string, _options: unknown, command: Command) => printResult(command, await sessionControl(developerSession(), developerEnv(command), id, action)));
  }
  session
    .command("take-over")
    .description("ask to take a session over; you confirm it from the link this prints")
    .argument("<session-id>", "the session's ID")
    .action(async (id: string, _options: unknown, command: Command) => printResult(command, await sessionTakeOver(developerSession(), developerEnv(command), id)));
  session
    .command("share")
    .description("share a session with a person, a project or the company")
    .argument("<session-id>", "the session's ID")
    .option("--with <who>", "a person's developer ID, project:<name>, or company")
    .option("--level <level>", "view, use or edit")
    .action(async (id: string, options: { with?: string; level?: string }, command: Command) =>
      printResult(command, await sessionShare(developerSession(), developerEnv(command), id, { ...(options.with === undefined ? {} : { with: options.with }), ...(options.level === undefined ? {} : { level: options.level }) })));
}
