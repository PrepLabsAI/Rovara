// FR-001 (Q1, Q2, Q12): which way agentx init asks its questions when neither --ui nor --no-ui is
// given. The page needs a person at an interactive terminal on a machine whose own screen can show
// a browser; anywhere else (--yes, CI, CloudShell, SSH, no terminal) the terminal path runs exactly
// as it always has.

export type InitUiMode = { mode: "page" } | { mode: "terminal"; noBrowser?: true };

/** Printed before the terminal's first question when only the missing browser kept the page away. */
export const NO_BROWSER_LINE =
  "No browser here, so agentx init asks in this terminal. To use the install page instead, run agentx init --ui --no-browser and open the address it prints (over SSH, forward its port with ssh -L).";

export function resolveUiMode(input: { ui: boolean | undefined; yes: boolean; injectedPrompter: boolean; interactive: boolean; browser: boolean }): InitUiMode {
  if (input.ui === true) return { mode: "page" };
  if (input.ui === false || input.yes || input.injectedPrompter || !input.interactive) return { mode: "terminal" };
  return input.browser ? { mode: "page" } : { mode: "terminal", noBrowser: true };
}

const set = (value: string | undefined) => value !== undefined && value !== "";

/** True when a browser opened here would show on this machine's own screen. */
export function browserAvailable(input: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv }): boolean {
  const { env } = input;
  // Over SSH a browser would open on the far machine's screen, if anywhere.
  if (set(env.SSH_CONNECTION) || set(env.SSH_TTY)) return false;
  // AWS CloudShell and CI runners have no screen.
  if (env.AWS_EXECUTION_ENV === "CloudShell") return false;
  if (set(env.CI) && env.CI !== "false") return false;
  if (input.platform === "darwin") return true;
  if (input.platform === "linux") return set(env.DISPLAY) || set(env.WAYLAND_DISPLAY);
  // Q12: openSystemBrowser has no Windows opener yet.
  return false;
}
