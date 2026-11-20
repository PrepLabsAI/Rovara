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
  -I) if [[ -n "\${FAKE_FAIL:-}" && "$rule" == *"$FAKE_FAIL"* ]]; then exit 1; fi; { printf '%s\\n' "$rule"; cat "$state"; } >"$state.new"; mv "$state.new" "$state" ;;
  -D) awk -v r="$rule" '!d && $0 == r { d = 1; next } { print }' "$state" >"$state.new"; mv "$state.new" "$state" ;;
  -S) awk -v c="$1" '$1 == c { print "-A " $0 }' "$state" ;;
  *) exit 2 ;;
esac
`;

/**
 * `bridge`: whether the kernel's bridge netfilter is there (a stand-in for /proc/sys/net/bridge/bridge-nf-call-iptables), which the setup-run rules need; off by default, so the tests below that predate
 * them see the rule set without them. `fail`: the fake refuses to insert any rule containing this text (a kernel without the module). The setup-isolation state file lands in the test's directory.
 */
function apply(options: { ip6tables: boolean; directory?: string; bridge?: boolean; fail?: string }) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "rovara-firewall-"));
  const bin = join(directory, "bin");
  spawnSync("mkdir", ["-p", bin]);
  for (const tool of options.ip6tables ? ["iptables", "ip6tables"] : ["iptables"]) { writeFileSync(join(bin, tool), FAKE); chmodSync(join(bin, tool), 0o755); }
  writeFileSync(join(bin, "modprobe"), "#!/bin/bash\nexit 0\n"); chmodSync(join(bin, "modprobe"), 0o755);
  if (options.bridge === true) writeFileSync(join(directory, "bridge-nf-call-iptables"), "1\n");
  // Only the fake tools and the system basics are on the path, so a machine's real ip6tables is never found.
  const system = ["/usr/bin", "/bin"].join(":");
  const env = { PATH: `${bin}:${system}`, FAKE_DIR: directory, FAKE_FAIL: options.fail ?? "", BRIDGE_NF: join(directory, "bridge-nf-call-iptables"), SETUP_ISOLATION_FILE: join(directory, "agentx", "setup-isolation") };
  const result = spawnSync("/bin/bash", ["-c", firewall], { env, encoding: "utf8" });
  const read = (tool: string) => { try { return readFileSync(join(directory, `${tool}.rules`), "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const state = (() => { try { return readFileSync(env.SETUP_ISOLATION_FILE, "utf8"); } catch { return undefined; } })();
  return { directory, status: result.status, stderr: result.stderr, iptables: read("iptables"), ip6tables: read("ip6tables"), state };
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
  // Setup runs (deferred check SH-1 / 2026-11-20 diagnosis): a run's sandbox (172.29.<slot>.3 on bridge rvbs<slot>) asks its own helper (.2) for every name. `-i rvb+` matches rvbs<slot> and
  // 172.29/16 lies inside 172.16/12, so without these rules above the range drops every query is dropped silently; and without the sandbox's port-53 drop it could skip the helper via the rvb+ resolver RETURNs.
  describe("the setup-run rules (rvbs+)", () => {
    const SETUP = [
      "DOCKER-USER -i rvbs+ -o rvbs+ -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN",
      "DOCKER-USER -i rvbs+ -o rvbs+ -m physdev --physdev-is-bridged -d 172.29.0.0/16 -p udp --dport 53 -j RETURN",
      "DOCKER-USER -i rvbs+ -o rvbs+ -m physdev --physdev-is-bridged -d 172.29.0.0/16 -p tcp --dport 53 -j RETURN",
      "DOCKER-USER -i rvbs+ -s 172.29.0.3/255.255.0.255 -p udp --dport 53 ! -o rvbs+ -j DROP",
      "DOCKER-USER -i rvbs+ -s 172.29.0.3/255.255.0.255 -p tcp --dport 53 ! -o rvbs+ -j DROP",
    ];
    const isWall = (rule: string) => rule.startsWith("DOCKER-USER -i rvb+ ");
    const expectAboveEveryWall = (rules: string[]) => {
      const lastSetup = Math.max(...SETUP.map((rule) => rules.indexOf(rule)));
      const firstWall = rules.findIndex(isWall);
      expect(SETUP.map((rule) => rules.indexOf(rule)).every((index) => index >= 0)).toBe(true);
      expect(firstWall).toBeGreaterThan(-1);
      expect(lastSetup).toBeLessThan(firstWall);
      // In the listed order, one block.
      const first = rules.indexOf(SETUP[0]!);
      expect(rules.slice(first, first + SETUP.length)).toEqual(SETUP);
    };

    it("are installed above the 172.16/12 drop and the resolver RETURNs, the metadata drop stays on top, and the state says ready", () => {
      const run = apply({ ip6tables: false, bridge: true });
      expect(run.status, run.stderr).toBe(0);
      expectAboveEveryWall(run.iptables);
      expect(run.iptables.filter((rule) => rule.startsWith("DOCKER-USER "))[0]).toBe("DOCKER-USER -d 169.254.169.254/32 -j DROP");
      expect(run.iptables.indexOf(SETUP[1]!)).toBeLessThan(run.iptables.indexOf("DOCKER-USER -i rvb+ -d 172.16.0.0/12 -j DROP"));
      expect(run.state).toBe("ready\n");
      expect(run.stderr).toContain("setup isolation: ready");
      // Nothing else changed: the rule set is the old one plus exactly these five.
      expect(run.iptables.filter((rule) => !SETUP.includes(rule))).toEqual(apply({ ip6tables: false }).iptables);
    });

    it("are idempotent: a re-run (the unit after a Docker restart) adds nothing and keeps ready", () => {
      const first = apply({ ip6tables: true, bridge: true });
      const second = apply({ ip6tables: true, bridge: true, directory: first.directory });
      expect(second.status, second.stderr).toBe(0);
      expect(second.iptables).toEqual(first.iptables);
      expect(second.state).toBe("ready\n");
    });

    it("are moved back above the walls when a re-run inserted a new resolver RETURN on top of them, and a partial set is completed in place of duplicates", () => {
      const first = apply({ ip6tables: false, bridge: true });
      const rules = join(first.directory, "iptables.rules");
      // A new resolver RETURN on top (what `f` does for a resolver that appeared after the first run), and one setup rule lost.
      const edited = ["DOCKER-USER -i rvb+ -d 10.9.9.9 -p udp --dport 53 -j RETURN", ...first.iptables.filter((rule) => rule !== SETUP[3])];
      writeFileSync(rules, `${edited.join("\n")}\n`);
      const second = apply({ ip6tables: false, bridge: true, directory: first.directory });
      expect(second.status, second.stderr).toBe(0);
      expectAboveEveryWall(second.iptables);
      for (const rule of SETUP) expect(second.iptables.filter((item) => item === rule)).toHaveLength(1);
      expect(second.state).toBe("ready\n");
    });

    it.each([["the physdev match (no br_netfilter / xt_physdev)", "physdev"], ["the conntrack match", "conntrack"], ["the sandbox's port-53 drop", "! -o rvbs+"]])(
      "when %s cannot be inserted, exactly the setup rules are rolled back, the boot goes on, and the state says unavailable", (_name, fail) => {
        const run = apply({ ip6tables: false, bridge: true, fail });
        expect(run.status, run.stderr).toBe(0);
        expect(run.iptables.filter((rule) => rule.includes("rvbs+"))).toEqual([]);
        expect(run.iptables).toEqual(apply({ ip6tables: false }).iptables);
        expect(run.state).toBe("unavailable\n");
        expect(run.stderr).toContain("setup isolation: unavailable");
      });

    it("without bridge netfilter in the kernel nothing is inserted, rules a previous run left are deleted by their exact text, and the state says unavailable", () => {
      const first = apply({ ip6tables: false, bridge: true });
      expect(first.state).toBe("ready\n");
      spawnSync("rm", ["-f", join(first.directory, "bridge-nf-call-iptables")]);
      const second = apply({ ip6tables: false, directory: first.directory });
      expect(second.status, second.stderr).toBe(0);
      expect(second.iptables).toEqual(first.iptables.filter((rule) => !SETUP.includes(rule)));
      expect(second.state).toBe("unavailable\n");
    });

    it("the rule text in boot.sh is exactly these five, deleted only with -D by that text (never by number or flush)", () => {
      for (const rule of SETUP) expect(firewall).toContain(`"${rule.replace("DOCKER-USER ", "")}"`);
      expect(firewall).toContain("iptables -D DOCKER-USER $r");
      expect(firewall).not.toMatch(/iptables -F|iptables -D DOCKER-USER [0-9]/u);
      // The state file: root-only directory, 0644 file, replaced whole (a reader never sees half a word); a failed write leaves no file, which the launcher reads as unavailable.
      expect(firewall).toContain('install -d -m 0700 "${F%/*}" && echo $s >"$F.t" && chmod 0644 "$F.t" && mv -f "$F.t" "$F" || rm -f "$F"');
      expect(firewall).toContain("F=${SETUP_ISOLATION_FILE:-/etc/agentx/setup-isolation}");
    });
  });

  describe("the worker launcher hands the setup-isolation state to the worker", () => {
    const launcher = /cat >\/usr\/local\/libexec\/agentx-worker-start <<'LAUNCHER'\n([\s\S]*?)\nLAUNCHER/.exec(bootScript)?.[1] ?? "";
    it("passes AGENTX_SETUP_ISOLATION, ready only for a root-owned 0644 regular file saying ready, before the image (the last argument)", () => {
      expect(launcher).toContain("args+=(--env AGENTX_SETUP_ISOLATION=$s)");
      expect(launcher).toContain("f=/etc/agentx/setup-isolation; [[ -f $f && ! -L $f && $(stat -c %u:%a $f) == 0:644 && $(<$f) == ready ]] && s=ready || s=unavailable");
      expect(launcher.indexOf("AGENTX_SETUP_ISOLATION=$s")).toBeLessThan(launcher.lastIndexOf('"$worker_image")'));
      expect(spawnSync("bash", ["-n"], { input: launcher, encoding: "utf8" }).status).toBe(0);
    });
    it("says unavailable for a missing file, a file not owned by root, and any other word", () => {
      const line = /^f=\/etc\/agentx\/setup-isolation;.*$/mu.exec(launcher)?.[0] ?? "";
      expect(line).not.toBe("");
      const directory = mkdtempSync(join(tmpdir(), "rovara-launcher-"));
      const probe = (content: string | undefined) => {
        const file = join(directory, "setup-isolation");
        spawnSync("rm", ["-f", file]);
        if (content !== undefined) { writeFileSync(file, content); chmodSync(file, 0o644); }
        return spawnSync("/bin/bash", ["-c", `${line.replace("f=/etc/agentx/setup-isolation", `f=${file}`)}\nprintf %s "$s"`], { encoding: "utf8" }).stdout;
      };
      // The test does not run as root, so even "ready" is refused here: only a root-owned file counts.
      for (const content of [undefined, "ready\n", "unavailable\n", "Ready\n", ""]) expect(probe(content)).toBe("unavailable");
    });
  });
});
