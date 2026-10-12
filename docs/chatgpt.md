# Sign in with ChatGPT

With Sign in with ChatGPT, a developer connects **their own** ChatGPT plan to Rovara, and the coding
tasks they start run on it instead of on the installation's model. People who haven't connected a plan
keep using the installation's model, as before.

It suits teams where developers already pay for ChatGPT and want their Rovara tasks to use that plan. It
doesn't replace the installation's model: that stays the default, and the fallback when a plan can't
serve a task.

## Who can use it

- **A ChatGPT Plus or Pro plan,** per [OpenAI's eligibility rules](https://developers.openai.com/siwc/quickstart).
  Rovara checks the plan when you connect, and keeps nothing if the plan can't be used.
- **One person's own plan.** Each connection belongs to the developer who made it, and only their tasks
  use it, including tasks they share with teammates. Rovara never lets one plan serve a team.
- **An installation an admin turned it on for.** It's off until an admin turns it on (below).

## Turn it on (admins)

```bash
npx @preplabsai/rovara-code --env <env> config set models.chatgpt.enabled true
```

The change shows its effect and asks first (`--yes` skips the question), and it's recorded like every
admin change. It needs the admin sign-in (`npx @preplabsai/rovara-code --env <env> login --admin`).

- **Turning it off** (`false`) stops new connections, and every task goes back to the installation's
  model. Existing connections are kept, and come back into use when it's turned on again.
- **The preferred model** is `gpt-6.1-sol`. Change it with
  `config set models.chatgpt.preferredModel <model>`. A task uses it only if the person's plan allows
  it; otherwise it uses the best model the plan allows.

Both keys are listed in the [day-2 guide](day-two.md).

## Connect your plan

OpenAI sends the end of the sign-in back to your own computer (`http://127.0.0.1:1455`), the only place
it allows. That's why there are two ways to finish.

### From Slack

1. Mention Rovara in a project channel: `@Rovara connect chatgpt`. Only you see the answer.
2. Press **Sign in with ChatGPT**, sign in to ChatGPT, and allow Rovara.
3. Your browser then shows an error such as *can't connect to 127.0.0.1*. **That's expected.** Copy the
   whole address from the browser's address bar.
4. Press **Paste the address**, paste it, and press **Connect**.

Rovara confirms the account it connected and the models your plan offers. The link works for 10 minutes,
and only for you: an address pasted by someone else is refused.

`@Rovara chatgpt status` shows your connection, and `@Rovara disconnect chatgpt` removes it.

### From the CLI

```bash
npx @preplabsai/rovara-code chatgpt connect
```

The CLI opens your browser and catches the sign-in on `127.0.0.1:1455` itself, so there's nothing to
paste. `--no-browser` prints the link instead.

You still paste the address in two cases:
- the port is already in use (the Codex CLI uses it while it signs in);
- your browser is on another computer.

The CLI asks for the address in both.

`chatgpt status` and `chatgpt disconnect` show and remove the connection. The CLI never sees your
ChatGPT tokens: it passes the sign-in to Rovara, which keeps the tokens encrypted (below).

## What happens when a task runs

A task you start runs on your plan, with the preferred model if your plan allows it. A teammate's turn in
a task you shared runs on your plan too, since the task is yours.

If your plan can't serve the task, the rest of the task runs on the installation's model, in the same
turn, without starting over. That happens when:

- **The plan reaches its usage limit.** Your next tasks use the installation's model for an hour, then
  try your plan again. Your usage is at [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage).
- **The connection is revoked or expired.** Connect again to use your plan.
- **The plan no longer allows the model.** Rovara reads your plan's model list again, so your next task
  picks a model it allows.

When such a task ends, Rovara says so once in its Slack thread, addressed to you, with what happened and
what to do. A private task started from an AI tool has no thread, so nothing is posted.

An OpenAI outage doesn't trigger this: the task fails as it would on any provider.

## How Rovara keeps your connection

- **Tokens:** Rovara's control plane keeps your ChatGPT tokens in its state table, encrypted with a key
  only it can use. The refresh token never leaves the control plane.
- **During a task:** the machine running your task gets a short-lived access token, asked for as needed,
  and kept only in memory.
- **No answers carry tokens:** neither Slack, the CLI nor any API answer ever includes them.

## Remove Rovara's access

Disconnecting in Rovara deletes the stored tokens. To also withdraw the permission at OpenAI, open
ChatGPT's **Settings**, then **Connected apps**, and remove **Rovara**. Your tasks then use the
installation's model until you connect again.
