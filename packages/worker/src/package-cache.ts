// Private packages P2a: the package cache of a workspace, and what the sandbox's commands are told about it.
//
// The Rovara install container (private-install.ts) downloads a repository's private packages with the company's token and leaves the tarballs in `<workspace>/.agentx-pkgcache/<manager>/` (a folder of the workspace root, outside every
// repository, with a `.gitignore` of `*`; NO authentication is in it). Once the token is gone, the repository's own install command (`npm ci`, `yarn install --frozen-lockfile`) runs in the sandbox as always, and these variables make it
// reinstall FROM THE CACHE, offline: the private packages are already there, the scripts run normally, and no request goes to the private registry.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export type CacheManager = "npm" | "yarn1";
export const PACKAGE_CACHE_DIRECTORY = ".agentx-pkgcache";
export const PACKAGE_CACHE_FOLDERS: Readonly<Record<CacheManager, string>> = { npm: "npm", yarn1: "yarn1" };
/** Written by the install step after a repository was installed AND the workspace scanned clean: until it exists, sandbox commands see no cache variables (a workspace with no private install is unchanged). */
export const PACKAGE_CACHE_MARKER = ".rovara-installed";

/** The variables every sandbox command of the workspace starts with once the install step left a cache. Paths and switches only; nothing secret. */
export function packageCacheEnvironment(rootPath: string): Record<string, string> {
  const base = join(resolve(rootPath), PACKAGE_CACHE_DIRECTORY);
  if (!existsSync(join(base, PACKAGE_CACHE_MARKER))) return {};
  return { npm_config_cache: join(base, PACKAGE_CACHE_FOLDERS.npm), npm_config_prefer_offline: "true", YARN_CACHE_FOLDER: join(base, PACKAGE_CACHE_FOLDERS.yarn1) };
}
