import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Offline data settings for the agent's task container (spec 043 FR-018). The agent works with no
 * network, so a library that refreshes reference data from the internet fails where grading, which
 * has network, does not: astropy's leap-second and Earth-orientation (IERS) tables made untouched
 * tests fail and hid an agent's own regressions on 2026-09-30. These settings make the offline
 * sandbox behave as grading does. They never reach the grading container, and do nothing where the
 * library is not installed.
 *
 * They cover test runs, where the harm was: pytest turns the failed refresh's warning into failures.
 * A plain script still prints astropy's "leap-second auto-update failed" warning and runs on the
 * bundled tables; astropy silences it only for auto_max_age = None, which its config file cannot
 * express (checked on 2026-09-30 against astropy__astropy-13398's image).
 */
export const OFFLINE_SETTINGS = ["astropy-iers-offline"] as const;

const PYTEST_PLUGIN = "agentx_offline";

/**
 * A pytest plugin, because astropy's own conftest points its config directory at a fresh temporary
 * folder for every test run, so a config file is never read during tests. pytest_configure runs
 * after that conftest.
 */
const PLUGIN_SOURCE = `# AgentX offline data settings (spec 043): see packages/worker/src/swebench/offline.ts.
def pytest_configure(config):
    try:
        from astropy.utils import iers
    except Exception:
        return
    iers.conf.auto_download = False
    iers.conf.auto_max_age = None
`;

/**
 * Writes the plugin under the run's root (which the task container mounts at the same path) and
 * returns the lines the task container's BASH_ENV file adds, so every shell command loads it.
 */
export async function offlineSettings(rootPath: string): Promise<string[]> {
  const directory = resolve(rootPath, ".agentx", "python");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `${PYTEST_PLUGIN}.py`), PLUGIN_SOURCE, { mode: 0o644 });
  return [
    "# Offline data settings (spec 043 FR-018): a pytest plugin, on the path for every Python.",
    `export PYTHONPATH="${directory}\${PYTHONPATH:+:$PYTHONPATH}"`,
    `export PYTEST_ADDOPTS="-p ${PYTEST_PLUGIN}\${PYTEST_ADDOPTS:+ $PYTEST_ADDOPTS}"`,
  ];
}
