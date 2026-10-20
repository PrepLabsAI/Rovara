import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The firewall rules ship inside boot.sh as one heredoc, which the Linux CI job extracts and runs unchanged. This runs the same heredoc against a fake
// iptables that keeps its rules in a file, so the rule set, its order and its idempotence are checked on any machine.
const bootScript = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
const firewall = /cat >\/usr\/local\/libexec\/rovara-container-firewall <<'FIREWALL'\n([\s\S]*?)\nFIREWALL/.exec(bootScript)?.[1] ?? "";

const FAKE = `#!/bin/bash
# A fake netfilter tool: one line per rule, the newest on top (like -I).
state="$FAKE_DIR/$(basename "$0").rules"; touch "$state"
op=$1; shift; rule="$*"
case $op in
  -C) grep -qxF -- "$rule" "$state" ;;
  -I) { printf '%s\\n' "$rule"; cat "$state"; } >"$state.new"; mv "$state.new" "$state" ;;
  *) exit 2 ;;
esac
`;

function apply(options: { ip6tables: boolean; directory?: string }) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "rovara-firewall-"));
  const bin = join(directory, "bin");
  spawnSync("mkdir", ["-p", bin]);
  for (const tool of options.ip6tables ? ["iptables", "ip6tables"] : ["iptables"]) { writeFileSync(join(bin, tool), FAKE); chmodSync(join(bin, tool), 0o755); }
  // Only the fake tools and the system basics are on the path, so a machine's real ip6tables is never found.
  const system = ["/usr/bin", "/bin"].join(":");
  const result = spawnSync("/bin/bash", ["-c", firewall], { env: { PATH: `${bin}:${system}`, FAKE_DIR: directory }, encoding: "utf8" });
  const read = (tool: string) => { try { return readFileSync(join(directory, `${tool}.rules`), "utf8").split("\n").filter(Boolean); } catch { return []; } };
  return { directory, status: result.status, stderr: result.stderr, iptables: read("iptables"), ip6tables: read("ip6tables") };
}

describe("the container firewall rules in boot.sh", () => {
  it("was found in boot.sh and is valid bash", () => {
    expect(firewall.length).toBeGreaterThan(200);
    expect(spawnSync("bash", ["-n"], { input: firewall, encoding: "utf8" }).status).toBe(0);
  });

  it("drops private, link-local and loopback destinations from build bridges, and every host port from both kinds of bridge", () => {
    const run = apply({ ip6tables: true });
    expect(run.status, run.stderr).toBe(0);
    for (const range of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8"]) {
      expect(run.iptables).toContain(`DOCKER-USER -i rvb+ -d ${range} -j DROP`);
    }
    expect(run.iptables).toContain("DOCKER-USER -d 169.254.169.254/32 -j DROP");
    // An internal bridge may forward only to itself; Docker's own isolation chains separate one internal bridge from another.
    expect(run.iptables).toContain("DOCKER-USER -i rvi+ ! -o rvi+ -j DROP");
    expect(run.iptables).toContain("INPUT -i rvb+ -j DROP");
    expect(run.iptables).toContain("INPUT -i rvi+ -j DROP");
    // Nothing is opened toward the host or the private ranges except the resolver's port 53, and that only for build bridges.
    for (const rule of run.iptables.filter((item) => item.endsWith("-j RETURN"))) expect(rule).toMatch(/^DOCKER-USER -i rvb\+ -d [0-9.]+ -p (udp|tcp) --dport 53 -j RETURN$/);
    expect(run.ip6tables).toEqual(["INPUT -i rvi+ -j DROP", "INPUT -i rvb+ -j DROP"]);
  });

  it("keeps the metadata drop above every rule that could let traffic through, and the resolver exceptions above the range drops", () => {
    const iptables = apply({ ip6tables: false }).iptables.filter((rule) => rule.startsWith("DOCKER-USER "));
    const index = (rule: string) => iptables.indexOf(rule);
    const imds = index("DOCKER-USER -d 169.254.169.254/32 -j DROP");
    expect(imds).toBe(0);
    const returns = iptables.filter((rule) => rule.endsWith("-j RETURN"));
    const rangeDrops = iptables.filter((rule) => /^DOCKER-USER -i rvb\+ -d [0-9./]+ -j DROP$/.test(rule));
    expect(rangeDrops).toHaveLength(6);
    for (const rule of returns) for (const drop of rangeDrops) expect(index(rule)).toBeLessThan(index(drop));
  });

  it("opens the resolvers named by the host's resolver files, when it has any, and no other address", () => {
    const files = ["/etc/resolv.conf", "/run/systemd/resolve/resolv.conf"].flatMap((file) => { try { return readFileSync(file, "utf8").split("\n"); } catch { return []; } });
    const expected = files.flatMap((line) => { const [word, address] = line.trim().split(/\s+/); return word === "nameserver" && /^[0-9.]+$/.test(address ?? "") ? [address!] : []; });
    const { iptables } = apply({ ip6tables: false });
    const opened = new Set(iptables.flatMap((rule) => /^DOCKER-USER -i rvb\+ -d ([0-9.]+) -p (?:udp|tcp) --dport 53 -j RETURN$/.exec(rule)?.[1] ?? []));
    expect([...opened].sort()).toEqual([...new Set(expected)].sort());
  });

  it("is idempotent: a second run installs nothing, and a run without ip6tables still succeeds", () => {
    const first = apply({ ip6tables: true });
    const second = apply({ ip6tables: true, directory: first.directory });
    expect(second.status, second.stderr).toBe(0);
    expect(second.iptables).toEqual(first.iptables);
    expect(second.ip6tables).toEqual(first.ip6tables);
    expect(new Set(second.iptables).size).toBe(second.iptables.length);
    const without = apply({ ip6tables: false });
    expect(without.status, without.stderr).toBe(0);
    expect(without.ip6tables).toEqual([]);
  });

  it("fails when iptables cannot install a rule, so the boot stops", () => {
    const directory = mkdtempSync(join(tmpdir(), "rovara-firewall-fail-"));
    const bin = join(directory, "bin");
    spawnSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "iptables"), "#!/bin/bash\nexit 1\n"); chmodSync(join(bin, "iptables"), 0o755);
    const result = spawnSync("/bin/bash", ["-c", firewall], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
  });
});
