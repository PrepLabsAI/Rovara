// FR-050: the GitHub App installation and repository access. The private key signs one JWT in
// memory and is never written anywhere.
import { githubAppJwt, githubAppSecretName, parseAppSecret } from "../init/github-app.js";
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
  let installations;
  try {
    installations = await services.github.listInstallations(jwt);
  } catch {
    return [check("github", "GitHub App", "fail", "GitHub refused the app's key, or could not be reached", `generate a new private key on the app's settings page and store it in ${githubAppSecretName(env)}`)];
  }
  const wanted = progress?.github?.installationId;
  const installation = wanted === undefined ? installations[0] : installations.find((entry) => String(entry.id) === wanted);
  if (installation === undefined) {
    return [check("github", "GitHub App", "fail", `the GitHub App ${app.slug} is not installed on ${app.account}`, `install it again: https://github.com/apps/${app.slug}/installations/new`)];
  }
  const token = await services.github.installationToken(jwt, String(installation.id));
  const count = await services.github.repositoryCount(token.token);
  if (count === 0) return [check("github", "GitHub App", "fail", `installed on ${installation.account.login}, but it sees no repository`, "choose the repositories AgentX may use in the app's installation settings on GitHub")];
  return [check("github", "GitHub App", "ok", `installed on ${installation.account.login}, sees ${count} ${count === 1 ? "repository" : "repositories"}`)];
}
