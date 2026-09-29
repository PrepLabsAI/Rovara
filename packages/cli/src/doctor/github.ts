// FR-050: the GitHub App installation and repository access. The private key signs one JWT in
// memory and is never written anywhere.
import { githubAppJwt, githubAppSecretName, parseAppSecret } from "../init/github-app.js";
import { plainMessage } from "../output.js";
import { check, type DoctorCheck, type DoctorContext } from "./checks.js";

export async function githubChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, progress, services } = context;
  const raw = await services.secrets.get(githubAppSecretName(env));
  let app;
  try {
    if (raw === undefined) throw new Error("missing");
    app = parseAppSecret(raw, githubAppSecretName(env));
  } catch {
    return [check("github", "GitHub App", "skip", `the secret ${githubAppSecretName(env)} cannot be read; the secrets check says why`)];
  }
  const jwt = githubAppJwt({ appId: app.appId, privateKey: app.privateKey, nowSeconds: Math.floor(services.now() / 1000) });
  const settingsPage = `https://github.com/apps/${app.slug}`;
  let installations;
  try {
    installations = await services.github.listInstallations(jwt);
  } catch (error) {
    if (/\bHTTP 401\b/.test(plainMessage(error))) {
      return [check("github", "GitHub App", "fail", "GitHub refused the app's key (HTTP 401)", `generate a new private key on the app's settings page and store it in ${githubAppSecretName(env)}`)];
    }
    return [check("github", "GitHub App", "fail", `could not reach GitHub to list the app's installations: ${plainMessage(error)}`, "check this computer's network access to github.com, then run agentx doctor again")];
  }
  const wanted = progress?.github?.installationId;
  const installation = wanted === undefined
    ? installations.find((entry) => entry.account.login.toLowerCase() === app.account.toLowerCase())
    : installations.find((entry) => String(entry.id) === wanted);
  if (installation === undefined) {
    return [check("github", "GitHub App", "fail", `the GitHub App ${app.slug} is not installed on ${app.account}`, `install it again: ${settingsPage}/installations/new`)];
  }
  let count: number;
  try {
    const token = await services.github.installationToken(jwt, String(installation.id));
    count = await services.github.repositoryCount(token.token);
  } catch (error) {
    return [check("github", "GitHub App", "fail", `installed on ${installation.account.login}, but its repositories could not be read: ${plainMessage(error)}`, "the installation may be suspended; check it in the installation settings on GitHub, then run agentx doctor again")];
  }
  if (count === 0) return [check("github", "GitHub App", "fail", `installed on ${installation.account.login}, but it sees no repository`, "choose the repositories AgentX may use in the app's installation settings on GitHub")];
  return [check("github", "GitHub App", "ok", `installed on ${installation.account.login}, sees ${count} ${count === 1 ? "repository" : "repositories"}`)];
}
