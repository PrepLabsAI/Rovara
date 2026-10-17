// Facts about the EC2 worker image, read from its Dockerfile (the image itself is built only by the
// release workflow): what a repository's setup and test commands can count on.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync("environments/base/Dockerfile", "utf8");
/** The final stage: everything after the last FROM line. */
const finalStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
const toolsStage = dockerfile.slice(dockerfile.indexOf(" AS tools"), dockerfile.lastIndexOf("\nFROM "));

describe("the worker image", () => {
  it("installs Python 3, pip and venv from Debian in the final stage", () => {
    const install = /apt-get install --yes --no-install-recommends ([^\n\\]+)/.exec(finalStage)?.[1] ?? "";
    for (const pkg of ["python3", "python3-pip", "python3-venv", "git", "openssh-client", "ca-certificates"]) {
      expect(install.split(/\s+/), pkg).toContain(pkg);
    }
    expect(finalStage).toContain("rm -rf /var/lib/apt/lists/*");
  });

  it("pins uv by version and by SHA-256 for each architecture, and verifies the download", () => {
    expect(toolsStage).toContain("ARG UV_VERSION=0.12.20");
    expect(toolsStage).toContain("uv_sha=8a7aad7bc76a2fae5151566ff3e43eacce0b2a113d5e4de3e4afe3e58fa2441e");
    expect(toolsStage).toContain("uv_sha=6590717592ace991ff83a63fef799e3ad9d33ecc8f96c5d6bdd732496e79337f");
    expect(toolsStage).toMatch(/arm64\) uv_arch=aarch64; uv_sha=8a7aad7bc76a2fae5151566ff3e43eacce0b2a113d5e4de3e4afe3e58fa2441e ;/);
    expect(toolsStage).toMatch(/amd64\) uv_arch=x86_64; uv_sha=6590717592ace991ff83a63fef799e3ad9d33ecc8f96c5d6bdd732496e79337f ;/);
    expect(toolsStage).toContain('https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$uv_arch-unknown-linux-gnu.tar.gz');
    expect(toolsStage).toMatch(/echo "\$uv_sha {2}\/tmp\/uv\.tgz" \| sha256sum -c -/);
  });

  it("copies uv and uvx into the final stage", () => {
    expect(finalStage).toContain("COPY --from=tools /usr/local/bin/uv /usr/local/bin/uv");
    expect(finalStage).toContain("COPY --from=tools /usr/local/bin/uvx /usr/local/bin/uvx");
  });

  it("still pins the Docker CLI and Compose by checksum (characterization)", () => {
    expect(toolsStage).toMatch(/echo "\$docker_sha {2}\/tmp\/docker\.tgz" \| sha256sum -c -/);
    expect(toolsStage).toMatch(/echo "\$compose_sha {2}\/tmp\/docker-compose" \| sha256sum -c -/);
  });

  it("runs the worker under tini, a pinned Debian package, so orphaned command processes are reaped (#170)", () => {
    // Commands run in their own process group (#170); a grandchild they leave behind is reparented
    // to PID 1, which must reap it.
    const install = /apt-get install --yes --no-install-recommends ([^\n\\]+)/.exec(finalStage)?.[1] ?? "";
    expect(install.split(/\s+/)).toContain("tini=0.19.0-1+b3");
    expect(finalStage).toMatch(/\nENTRYPOINT \["\/usr\/bin\/tini", "--"\]\n/);
    expect(finalStage).toMatch(/\nCMD \["node", "packages\/worker\/dist\/main\.js"\]\n?$/);
    expect(finalStage.indexOf("ENTRYPOINT")).toBeLessThan(finalStage.indexOf("\nCMD "));
  });

  it("is started by the EC2 boot script without overriding its entrypoint (#170, characterization)", () => {
    const boot = readFileSync("packages/worker/ec2/boot.sh", "utf8");
    const unit = boot.slice(boot.indexOf('cat >"/etc/systemd/system/$WORKER_UNIT" <<EOF'), boot.indexOf("EOF\n}", boot.indexOf('cat >"/etc/systemd/system/$WORKER_UNIT" <<EOF')));
    const launcher = /cat >\/usr\/local\/libexec\/agentx-worker-start <<'LAUNCHER'\n([\s\S]*?)\nLAUNCHER/.exec(boot)?.[1] ?? "";
    expect(unit).toContain("ExecStart=/usr/local/libexec/agentx-worker-start");
    expect(launcher).not.toBe("");
    expect(launcher).toContain('[[ "$worker_image" =~ ^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$ ]]');
    expect(launcher).toContain('args=(run --rm --name "$WORKER_CONTAINER" --network host --env-file "$WORKER_ENV_FILE" --volume "$MOUNT_PATH:$MOUNT_PATH")');
    expect(launcher).not.toContain("--entrypoint");
    expect(launcher).not.toContain("--init");
    // The generated launcher uses the pinned image as the final docker run argument and leaves
    // its image ENTRYPOINT (tini) and CMD (the worker) in effect.
    expect(launcher).toMatch(/args\+=\([^\n]*"\$worker_image"\)\nexec "\$docker" "\$\{args\[@\]\}"/);
    expect(launcher.trimEnd().endsWith('exec "$docker" "${args[@]}"')).toBe(true);
  });

  it("runs as the node user", () => {
    expect(finalStage).toMatch(/\nUSER node\n/);
  });

  it("ships the exact Node, Docker CLI, runner package, and verifier needed by contained setup smoke", () => {
    expect(dockerfile).toContain("node:22.23.2-bookworm-slim@sha256:");
    expect(finalStage).toContain("COPY --from=tools /usr/local/bin/docker /usr/local/bin/docker");
    expect(finalStage).toContain("COPY --from=build /opt/agentx/node_modules ./node_modules");
    expect(finalStage).toContain("COPY --from=build /opt/agentx/package-lock.json ./package-lock.json");
    expect(finalStage).toContain("COPY --from=build /opt/agentx/packages/verifier ./packages/verifier");
    expect(dockerfile).toContain("COPY upstream/e2e-0.20.0.tgz upstream/e2e-0.20.0.tgz");
    expect(dockerfile).toContain("WORKDIR /opt/agentx");
  });
});
