// A coding run that ends with no code change keeps what it found: the commands the agent ran, their output and its own conclusion. This is the shape, its bounds and its redaction
// (the worker builds it before it leaves; the broker rebuilds whatever arrives before it is stored or shown).
import { describe, expect, it } from "vitest";
import {
  NO_CHANGE_FINDINGS_COMMANDS_MAX, NO_CHANGE_FINDINGS_COMMAND_MAX, NO_CHANGE_FINDINGS_CONCLUSION_MAX, NO_CHANGE_FINDINGS_OUTPUT_MAX, NO_CHANGE_FINDINGS_TOTAL_MAX,
  NO_CODE_CHANGED_LEGACY_REASONS, NO_CODE_CHANGED_REASON, NoChangeFindingsSchema, buildNoChangeFindings, isNoCodeChangedReason, noChangeFindingsFrom, noChangeFindingsSize,
  NO_CHANGE_FINDINGS_OMITTED_MAX, NO_CHANGE_OUTPUT_HIDDEN, NO_CHANGE_VALUE_HIDDEN, commandReadsSecrets, maskSecretValues, isSecretName, noChangeHasThread,
} from "../../packages/contracts/src/no-change-findings.js";
import { FindingsRecorder, RunFindings } from "../../packages/worker/src/no-change-findings.js";
import { WORKFLOW_BLOCK_REASONS } from "../../packages/contracts/src/task-workflow.js";
import { WorkflowSnapshotSchema, blockWorkflow, createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";

// Built at run time: no key-shaped literal is in this file.
const secret = (): string => ["ghp_", "Ab12".repeat(9)].join("");
const awsKey = (): string => ["AKIA", "QWERTYUIOPASDFGH"].join("");

describe("buildNoChangeFindings", () => {

  it("caps everything: many commands, huge outputs and a huge conclusion stay under the fixed limits, and the last commands are the ones kept", () => {
    const commands = Array.from({ length: 40 }, (_, index) => ({ command: `run-${String(index)} ${"x".repeat(1000)}`, output: `out-${String(index)} ${"y".repeat(50_000)}` }));
    const findings = buildNoChangeFindings({ commands, conclusion: "z".repeat(30_000) });
    expect(findings.commands).toHaveLength(NO_CHANGE_FINDINGS_COMMANDS_MAX);
    expect(findings.omitted).toBe(30);
    expect(findings.commands[0]!.command.startsWith("run-30 ")).toBe(true);
    expect(findings.commands.at(-1)!.command.startsWith("run-39 ")).toBe(true);
    for (const item of findings.commands) {
      expect(item.command.length).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_COMMAND_MAX);
      expect((item.output ?? "").length).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_OUTPUT_MAX);
    }
    expect(findings.conclusion!.length).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_CONCLUSION_MAX);
    expect(noChangeFindingsSize(findings)).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_TOTAL_MAX);
    expect(NoChangeFindingsSchema.safeParse(findings).success).toBe(true);
  });

  it("redacts a secret in a command, its output and the conclusion (positive control: the plain text did hold it)", () => {
    const token = secret(), key = awsKey();
    const raw = { commands: [{ command: `curl -H "Authorization: Bearer ${token}" https://example.test`, output: `found ${token} and ${key}` }], conclusion: `The key ${key} is in the environment.` };
    expect(JSON.stringify(raw)).toContain(token);
    const text = JSON.stringify(buildNoChangeFindings(raw));
    expect(text).not.toContain(token);
    expect(text).not.toContain(key);
    expect(text).toContain("[REDACTED]");
  });

  it("makes a command one line, drops control characters, and leaves out anything that is not text", () => {
    const findings = buildNoChangeFindings({ commands: [{ command: "echo a\n\techo b\u0007" }, { command: 42 }, { output: "no command" }, null as never, { command: "   " }], conclusion: 7 });
    expect(findings).toEqual({ commands: [{ command: "echo a echo b" }] });
  });

});

describe("noChangeFindingsFrom: a result's block is rebuilt on this side", () => {
  it("is undefined when there is no block at all (an older worker), and for anything that is not an object", () => {
    for (const raw of [undefined, null, "text", 4, [], [{ commands: [] }]]) expect(noChangeFindingsFrom(raw)).toBeUndefined();
  });

  it("survives a malformed block without throwing", () => {
    expect(noChangeFindingsFrom({ commands: "nope", conclusion: { a: 1 }, omitted: "many" })).toEqual({ commands: [] });
    expect(noChangeFindingsFrom({ commands: [1, "two", { command: { deep: true } }] })).toEqual({ commands: [] });
  });
});

describe("the block reason", () => {
  it("is the new wording, and the wording stored before still reads as this stop", () => {
    expect(WORKFLOW_BLOCK_REASONS.noCodeChanged).toBe(NO_CODE_CHANGED_REASON);
    expect(isNoCodeChangedReason(NO_CODE_CHANGED_REASON)).toBe(true);
    for (const legacy of NO_CODE_CHANGED_LEGACY_REASONS) expect(isNoCodeChangedReason(legacy)).toBe(true);
    expect(isNoCodeChangedReason("Coding stopped before it finished.")).toBe(false);
    expect(isNoCodeChangedReason(undefined)).toBe(false);
    expect(NO_CODE_CHANGED_LEGACY_REASONS[0]).toContain("no code changed");
    expect(NO_CODE_CHANGED_REASON).not.toMatch(/verified|checks passed/iu);
  });
});

describe("blocking a coding step keeps findings only for the no-code-change stop", () => {
  const now = "2026-10-26T12:00:00.000Z";
  const plan = { id: "plan-v1", type: "plan" as const, version: 1, sha256: "c".repeat(64), producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: now };
  const coding = () => WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now }), revision: 5, stage: "IMPLEMENT", state: "RUNNING", artifacts: [plan] });
  const found = { commands: [{ command: "ls" }], conclusion: "Nothing to change." };

  it("keeps them with the no-code-change reason, and drops an earlier run's when the step is blocked again for another reason", () => {
    const stopped = blockWorkflow(coding(), NO_CODE_CHANGED_REASON, now, { noChangeFindings: found });
    expect(stopped.noChangeFindings).toEqual(found);
    expect(stopped).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: NO_CODE_CHANGED_REASON });
    const again = blockWorkflow({ ...stopped, state: "RUNNING" }, "implementation operation ended failed", now, { noChangeFindings: found });
    expect(again.noChangeFindings).toBeUndefined();
    expect(blockWorkflow({ ...stopped, state: "RUNNING" }, "implementation operation ended failed", now).noChangeFindings).toBeUndefined();
  });

});

// Values built at run time: no key-shaped literal is in this file.
const salt = (): string => ["s4lt", "Zq81".repeat(4)].join("-");
const hmac = (): string => ["h", "9f3a".repeat(8)].join("");
const stripe = (): string => ["rk_", "live_", "Q7w2".repeat(6)].join("");

describe("commands that read environment or secret material", () => {
  it("are recognised, however they are written", () => {
    for (const command of [
      "cat .env", "cat .env.production", "cat ./app/.env.local", "env", "env | sort", "FOO=1 env", "printenv", "printenv API_TOKEN", "set", "export -p", "export", "head -n5 server.pem", "tail ~/.ssh/id_rsa",
      "grep -n x credentials.json", "less config/secrets.yml", "cat .npmrc", "cat ~/.netrc", "cat .pypirc", "cat .git-credentials", "cat ~/.kube/kubeconfig", "cat ~/.aws/credentials",
      "cat ~/.docker/config.json", "cd app && cat '.env'", 'cat "$(pwd)/.env"', "cat < .env", "grep KEY --file=.env", "cat /proc/self/environ", "read app/.env", "grep -rn x *.key",
    ]) expect(commandReadsSecrets(command), command).toBe(true);
    for (const command of ["grep -rn retry src", "npm test", "ls src", "env NODE_ENV=test npm test", "export FOO=1", "cat package.json", "read app/a.ts", "git log --oneline"]) expect(commandReadsSecrets(command), command).toBe(false);
  });

  it("keep no output of a file read: the output of `read` is left out", () => {
    const findings = buildNoChangeFindings({ commands: [{ command: "read app/a.ts", output: "export const x = 1;" }] });
    expect(findings.commands).toEqual([{ command: "read app/a.ts" }]);
  });
});

describe("secret-looking values are hidden", () => {
  it("masks KEY=value and KEY: value where the key looks like a secret's name, keeping the key, in an output and in the conclusion", () => {
    const output = `API_TOKEN=abc123\nmy_password = "two words"\nsession_cookie: deadbeef\n  - private_key: xyz\n"client_secret": "v",\nUSER_AUTH=${stripe()}\nPORT=3000\nNAME: plain`;
    const masked = maskSecretValues(output);
    expect(masked).toBe(`API_TOKEN=${NO_CHANGE_VALUE_HIDDEN}\nmy_password = ${NO_CHANGE_VALUE_HIDDEN}\nsession_cookie: ${NO_CHANGE_VALUE_HIDDEN}\n  - private_key: ${NO_CHANGE_VALUE_HIDDEN}\n"client_secret": ${NO_CHANGE_VALUE_HIDDEN}\nUSER_AUTH=${NO_CHANGE_VALUE_HIDDEN}\nPORT=3000\nNAME: plain`);
    const findings = buildNoChangeFindings({ commands: [{ command: "node dump.js", output: `SIGNING_SALT=${salt()}\nHMAC: ${hmac()}\nOK=1` }], conclusion: `The service reads PASS=${hmac()} and\nAuth: Bearer-ish ${salt()}\nfrom its config.` });
    const text = JSON.stringify(findings);
    for (const value of [salt(), hmac()]) expect(text).not.toContain(value);
    expect(findings.commands[0]!.output).toBe(`SIGNING_SALT=${NO_CHANGE_VALUE_HIDDEN}\nHMAC: ${NO_CHANGE_VALUE_HIDDEN}\nOK=1`);
    expect(findings.conclusion).toContain(`PASS=${NO_CHANGE_VALUE_HIDDEN}`);
    expect(findings.conclusion).toContain(`\nAuth: ${NO_CHANGE_VALUE_HIDDEN}\nfrom its config.`);
  });

  it("also hides a value written in a command, and leaves ordinary text alone", () => {
    const command = buildNoChangeFindings({ commands: [{ command: `API_KEY=${hmac()} npm run build` }] }).commands[0]!.command;
    expect(command).toContain(`API_KEY=${NO_CHANGE_VALUE_HIDDEN}`);
    expect(command).not.toContain(hmac());
    expect(maskSecretValues("12 passed, 0 failed\nsrc/retry.ts:9: export const retry = true;")).toBe("12 passed, 0 failed\nsrc/retry.ts:9: export const retry = true;");
  });

});

describe("`omitted` never passes the schema's maximum", () => {
  it("is clamped where the block is built, in the contracts and in the worker, and where it is rebuilt", () => {
    const many = Array.from({ length: NO_CHANGE_FINDINGS_OMITTED_MAX + 200 }, (_, index) => ({ command: `c${String(index)}` }));
    const built = buildNoChangeFindings({ commands: many });
    expect(built.omitted).toBe(NO_CHANGE_FINDINGS_OMITTED_MAX);
    expect(NoChangeFindingsSchema.safeParse(built).success).toBe(true);
    const rebuilt = noChangeFindingsFrom({ commands: many.slice(0, 50), omitted: NO_CHANGE_FINDINGS_OMITTED_MAX + 5 })!;
    expect(rebuilt.omitted).toBe(NO_CHANGE_FINDINGS_OMITTED_MAX);
    expect(NoChangeFindingsSchema.safeParse(rebuilt).success).toBe(true);
    const recorder = new FindingsRecorder();
    for (let index = 0; index < NO_CHANGE_FINDINGS_OMITTED_MAX + 200; index += 1) recorder.observe({ type: "tool_execution_start", toolCallId: `t${String(index)}`, toolName: "bash", args: { command: `c${String(index)}` } });
    const found = recorder.build();
    expect(found.omitted).toBe(NO_CHANGE_FINDINGS_OMITTED_MAX);
    expect(found.commands).toHaveLength(10);
    expect(NoChangeFindingsSchema.safeParse(found).success).toBe(true);
  });
});

describe("the worker's recorder", () => {
  it("keeps the output of a shell command and not of a file read", () => {
    const recorder = new FindingsRecorder();
    recorder.observe({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "ls src" } });
    recorder.observe({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: { content: [{ type: "text", text: "a.ts\nb.ts" }] } });
    recorder.observe({ type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "src/a.ts" } });
    recorder.observe({ type: "tool_execution_end", toolCallId: "b", toolName: "read", result: { content: [{ type: "text", text: "FILE TEXT" }] } });
    expect(recorder.build().commands).toEqual([{ command: "ls src", output: "a.ts\nb.ts" }, { command: "read src/a.ts" }]);
  });
});

/** One tool call's two events, as a session emits them. */
const callEvents = (id: string, command: string, text: string): [unknown, unknown] => [
  { type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command } },
  { type: "tool_execution_end", toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text }] } },
];

describe("a run split into parts: one recorder for each part's session", () => {
  const A = "part-a", B = "part-b", C = "part-c";

  it("numbers a part by its place in the plan, and leaves out a part that wrote no conclusion", () => {
    const run = new RunFindings();
    run.setOrder([A, B, C]);
    run.forPart(A).concludeWith(undefined);
    run.forPart(C).concludeWith("Only the last part spoke.");
    run.forPart(B).concludeWith("The middle part spoke.");
    expect(run.build().conclusion).toBe("Part 2:\nThe middle part spoke.\n\nPart 3:\nOnly the last part spoke.");
  });

  it("keeps the caps over the combined list: the last ten commands overall, the omitted count, and the conclusion cap with every part still heard", () => {
    const run = new RunFindings();
    run.setOrder([A, B, C]);
    let id = 0;
    for (const [key, name] of [[A, "a"], [B, "b"], [C, "c"]] as const) {
      for (let index = 0; index < 70; index += 1) {
        const [start, end] = callEvents(`t${String(id += 1)}`, `${name}-${String(index)} ${"x".repeat(1000)}`, `out-${name}-${String(index)} ${"y".repeat(50_000)}`);
        run.forPart(key).observe(start); run.forPart(key).observe(end);
      }
      run.forPart(key).concludeWith(`${name.toUpperCase()}-START ${"z".repeat(30_000)} ${name.toUpperCase()}-END`);
    }
    const found = run.build();
    expect(found.commands).toHaveLength(NO_CHANGE_FINDINGS_COMMANDS_MAX);
    // 210 calls were made; each recorder holds its last 60 and counts the rest (10 each); the block keeps the last ten of the combined list.
    expect(found.omitted).toBe(200);
    // Each part's last command is kept first (a-69, b-69, c-69 are the last each part ran), then the most recent overall.
    expect(found.commands.map((item) => item.command.split(" ")[0])).toEqual(["a-69", "b-69", ...Array.from({ length: 8 }, (_, index) => `c-${String(62 + index)}`)]);
    for (const item of found.commands) {
      expect(item.command.length).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_COMMAND_MAX);
      expect((item.output ?? "").length).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_OUTPUT_MAX);
    }
    expect(found.conclusion!.length).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_CONCLUSION_MAX);
    expect(found.conclusion).toMatch(/^Part 1:\nA-START[\s\S]*\n\nPart 2:\nB-START[\s\S]*\n\nPart 3:\nC-START/u);
    expect(noChangeFindingsSize(found)).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_TOTAL_MAX);
    expect(NoChangeFindingsSchema.safeParse(found).success).toBe(true);
  });

  it("keeps the label of every part shown, however many parts there are: the first 20 are told, the rest are counted", () => {
    const run = new RunFindings();
    const ids = Array.from({ length: 100 }, (_, index) => `p${String(index)}`);
    run.setOrder(ids);
    for (const key of ids) run.forPart(key).concludeWith(`${key} found a long answer ${"w".repeat(500)}`);
    const found = run.build();
    const text = found.conclusion!;
    expect(text.length).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_CONCLUSION_MAX);
    for (let number = 1; number <= 20; number += 1) expect(text, `Part ${String(number)}`).toContain(`Part ${String(number)}:\np${String(number - 1)} found`);
    expect(text).not.toContain("Part 21:");
    expect(text.endsWith("…and 80 more parts")).toBe(true);
  });

  it("a run with one part, or with none, reads exactly as one recorder did: no label", () => {
    const single = new FindingsRecorder();
    const run = new RunFindings();
    run.setOrder([A]);
    const part = run.forPart(A);
    for (const recorder of [single, part]) {
      for (const event of callEvents("t1", "npm test", "3 passed")) recorder.observe(event);
      recorder.concludeWith("We do use retry.\nAgentX result: done");
    }
    expect(run.build()).toEqual(single.build());
    expect(run.build().conclusion).toBe("We do use retry.");
    const none = new RunFindings();
    for (const event of callEvents("t1", "npm test", "3 passed")) none.main.observe(event);
    none.main.concludeWith("Plain.");
    expect(none.build()).toEqual({ commands: [{ command: "npm test", output: "3 passed" }], conclusion: "Plain." });
  });
});

describe("secret names are matched as whole name parts", () => {
  it("splits a name at `_`, `-`, `.` and camelCase: API_KEY, apiKey and db.password are secret names; author, monkey and bypass are not", () => {
    for (const name of ["API_KEY", "apiKey", "db.password", "SIGNING_SALT", "HMAC", "session-token", "GITHUB_TOKEN", "AuthToken", "user_credentials", "COOKIE"]) expect(isSecretName(name), name).toBe(true);
    for (const name of ["author", "AUTHOR", "monkey", "bypass", "keyboard", "tokenizer", "PORT", "NODE_ENV", "passed"]) expect(isSecretName(name), name).toBe(false);
  });

  it("masks the value of the first kind and leaves the second kind alone, in an output and in the conclusion", () => {
    const text = `apiKey=${hmac()}\ndb.password: ${salt()}\nauthor=Ada\nmonkey=1\nbypass: yes\nAPI_KEY=${stripe()}`;
    const masked = maskSecretValues(text);
    expect(masked).toBe(`apiKey=${NO_CHANGE_VALUE_HIDDEN}\ndb.password: ${NO_CHANGE_VALUE_HIDDEN}\nauthor=Ada\nmonkey=1\nbypass: yes\nAPI_KEY=${NO_CHANGE_VALUE_HIDDEN}`);
    const found = buildNoChangeFindings({ commands: [{ command: "node dump.js", output: "author=Ada\nDB_PASS=x1" }], conclusion: "monkey=1 and apiKey=abc" });
    expect(found.commands[0]!.output).toBe(`author=Ada\nDB_PASS=${NO_CHANGE_VALUE_HIDDEN}`);
    expect(found.conclusion).toBe(`monkey=1 and apiKey=${NO_CHANGE_VALUE_HIDDEN}`);
  });

});

describe("a command that refers to a secret variable shows no output", () => {

  it("keeps no output of such a command in the block", () => {
    const found = buildNoChangeFindings({ commands: [{ command: "echo $GITHUB_TOKEN", output: hmac() }, { command: 'echo "$DB_PASSWORD"', output: salt() }, { command: "echo $HOME", output: "/home/x" }] });
    expect(found.commands.map((item) => item.output)).toEqual([NO_CHANGE_OUTPUT_HIDDEN, NO_CHANGE_OUTPUT_HIDDEN, "/home/x"]);
    expect(JSON.stringify(found)).not.toContain(hmac());
  });
});

describe("whether a task has a Slack thread", () => {
  it("reads the view's `threadUrl` and the record's `threadTs` alike, so the page and the app choose the same last line", () => {
    expect(noChangeHasThread(undefined)).toBe(false);
    expect(noChangeHasThread({})).toBe(false);
    expect(noChangeHasThread({ threadUrl: "https://x.slack.com/archives/C1/p1" })).toBe(true);
    expect(noChangeHasThread({ threadTs: "1760000000.000100" })).toBe(true);
  });
});
