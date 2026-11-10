// Script tokens: the install switch. Leaf module. Cloud keeps this behind a stack parameter that is off until an owner turns it on; on a laptop a token exists only after the owner
// makes one on a local page, so the default is ON and the owner can turn the whole feature off with `ROVARA_SCRIPT_TOKENS=0`. Off: no token authenticates, whatever is stored, and the local
// pages and routes for tokens answer as if they did not exist.
export const SCRIPT_TOKENS_SWITCH_VARIABLE = "ROVARA_SCRIPT_TOKENS";

/** Whether script tokens exist on this install. Only exactly "0" turns them off. */
export const scriptTokensEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env[SCRIPT_TOKENS_SWITCH_VARIABLE] !== "0";
