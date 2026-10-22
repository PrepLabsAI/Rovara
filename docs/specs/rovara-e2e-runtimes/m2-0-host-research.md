# M2.0 Mobile Test Host Research (paper only)

Status: research, 2026-10-22. Nothing was launched, created or price-checked with AWS credentials. This is input to the M2.0 host decision in `roadmap.md`; it is not that decision. The M2.0 exit demo (emulator boots and installs an APK on the chosen host) still needs a hands-on spike after the owner approvals in §7.

## Plain-language summary

- **Android:** Android's emulator needs hardware virtualization (KVM). Until February 2026 that meant renting a whole physical server on AWS (a "metal" instance, about **$4–5.50 an hour**). AWS now lets ordinary Intel virtual machines run KVM inside them ("nested virtualization"). A mid-size one, **`c8i.2xlarge`**, costs about **$0.375 an hour**, roughly a tenth of the cheapest metal option, and should fit two emulators. It may be slower than metal; the spike measures that. If it is too slow, fall back to `c7i.metal-24xl` (about $4.28/h) for the spike only.
- **iOS:** needs a real Mac. AWS rents Macs only as a whole dedicated machine with a **24-hour minimum**. The cheapest sensible one (`mac2-m2.metal`) is about **$0.878/h, so $21.07 per 24 h allocation**; a full month is about **$641**. iOS should wait until Android (M2.1) ships, as the roadmap orders; then book one 24 h allocation per test burst and release it.
- **Monthly cost (scenario A, burst only):** about **$16** of Android plus **$21** for one Mac day, so **about $37/month** before storage. Holding a Mac all month costs about $641; running a metal Android host 24/7 costs about $3,100.
- **What the owner needs to approve:** listed in §7 (instance types, a monthly spend cap of $150 for M2.0, and a vCPU quota check). No quota increase is needed for the recommended Android path.

## 1. Sources and how they were read

All read on **2026-10-22**. This session's fetch tool could not resolve `aws.amazon.com`, `docs.aws.amazon.com` or `developer.android.com` directly, so figures below come from web-search extracts of those pages and of pricing aggregators that mirror the AWS Price List API. **Every price must be re-checked on the AWS pricing page or Pricing Calculator before approval** (the approval in §7 says so).

| # | Source | Used for |
|---|---|---|
| S1 | https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-ec2-nested-virtualization-on-virtual/ (2026-02-16) | Nested KVM/Hyper-V on C8i, M8i, R8i; mobile emulators named as a use case |
| S2 | https://aws.amazon.com/about-aws/whats-new/2026/06/nested-virtualization-intel-us-gov-cloud/ (2026-06-18) | Extended to C7i, M7i, R7i, I7i, X8i, `-flex` and `d` variants |
| S3 | https://repost.aws/articles/ARowyP4itvSfSZEmflfvtbUA/nested-virtualization-on-virtual-amazon-ec2-instances ; https://www.infoq.com/news/2026/03/aws-ec2-nested-virtualization/ | Enable with `--cpu-options NestedVirtualization=enabled` (stopped instance or at launch); Graviton not supported; no hibernation; AWS still recommends metal for performance-sensitive work; no surcharge |
| S4 | https://github.com/google/android-emulator-container-scripts | Emulator containers need `/dev/kvm`; nested virtualization "may result in reduced performance" |
| S5 | https://developer.android.com/studio/run/emulator-acceleration | `emulator -accel-check`; KVM required for usable speed on Linux |
| S6 | https://developer.android.com/studio/releases/emulator | Emulator 37.1.11 (2026-07-30); API 37 AVDs need ≥ 4 GB RAM; arm64 Linux hosts only via source cross-compile with `swiftshader_indirect` GPU |
| S7 | https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html ; …/mac-instance-stop.html ; https://aws.amazon.com/ec2/instance-types/mac/faqs/ | Mac only on Dedicated Hosts; 24 h minimum allocation (Apple licence); stop/terminate then `release-hosts`; scrubbing not billed |
| S8 | https://instances.vantage.sh, https://calculator.holori.com, https://www.devzero.io/instances/aws, https://www.economize.cloud (Price List API mirrors, us-east-1 Linux On-Demand) | Hourly prices in §2–§3 |
| S9 | https://dev.classmethod.jp/en/articles/ec2-mac-m3ultra-metal-pricing-api/ ; https://macyou.co/blog/aws-ec2-mac-pricing-explained | Mac Dedicated Host hourly prices (Pricing API) and 24 h minimums |
| S10 | https://gist.github.com/atyachin/2f7c6054c4cd6945397165a23623987d | Community: emulator on Graviton needs metal for KVM; some arm64 images crashed |
| S11 | https://aws.amazon.com/blogs/aws/announcing-amazon-ec2-m4-and-m4-pro-mac-instances | M4 Mac specs; "more tests in parallel using multiple device simulators" (claim, not a measurement) |
| S12 | https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-instance-termination-notices.html | Spot two-minute interruption notice |

**Not verified anywhere:** published Android emulator boot times on nested-virtualization C8i/M8i (none found); Spot availability with nested virtualization enabled; a supported prebuilt Android emulator package for arm64 Linux hosts; measured iOS simulator concurrency per Mac type. The spike measures the first and last.

## 2. Android emulator hosting on AWS

What M2.1 needs from a host: `/dev/kvm`, an x86_64 Linux host (the recipe contract pins `abi: "x86_64"`, `packages/contracts/src/e2e-native-recipes.ts:12`), ≥ 4 GB RAM and ~2–4 vCPU per emulator (S6), a fresh emulator per run (`-wipe-data -no-snapshot` or a throwaway AVD copy), and the M1 containment: emulator container on the run's `--internal` network, no egress, sinkhole DNS, no IMDS.

### 2.1 Options compared (us-east-1, Linux On-Demand, S8)

| Option | KVM | vCPU / RAM | $/h | Parallel emulators (est.) | Notes |
|---|---|---|---|---|---|
| **(b) `c8i.2xlarge`, nested virt** | Yes, nested (S1, S3) | 8 / 16 GiB | **0.3748** | 2 | Cheapest KVM host; perf unmeasured; 8th-gen Intel |
| (b) `c8i.4xlarge`, nested virt | Yes, nested | 16 / 32 GiB | ~0.75 (2× 2xlarge, linear family pricing) | 4–5 | Scale-up if 2 is too few |
| (b) `c7i.2xlarge`, nested virt | Yes, nested since 2026-06 (S2) | 8 / 16 GiB | 0.357 | 2 | Slightly cheaper, older CPU; same caveat |
| (a) `c7i.metal-24xl` | Yes, native | 96 / 192 GiB | 4.284 | ~20 (RAM/CPU bound) | Smallest current-gen x86 metal; fallback |
| (a) `c5.metal` | Yes, native | 96 / 192 GiB | 4.08 | ~20 | Cheapest x86 metal; 2017-era Skylake/Cascade Lake |
| (a) `m5.metal` | Yes, native | 96 / 384 GiB | 4.608 | ~20 | More RAM than needed |
| (a) `c6i.metal` | Yes, native | 128 / 256 GiB | 5.44 | ~25 | Most expensive, no benefit at our scale |
| (c) `c7g.metal` (Graviton3) | Yes, native arm64 KVM (S10) | 64 / 128 GiB | 2.32 | unknown | No supported emulator build for arm64 Linux hosts (S6); breaks the x86_64 recipe pin |
| (c) `c6g.metal` / `m7g.metal` | Same | 64 / 128–256 GiB | 2.176 / 2.611 | unknown | Same blockers |
| (c) Graviton virtual (e.g. today's `m6g.large` runner) | **No** — nested virt excludes Graviton (S3) | — | — | 0 (software emulation only) | Not viable |

"Parallel emulators" is an estimate: 4 GB guest RAM + ~1 GB host overhead and ~2–4 vCPU per emulator, leaving room for adb, the e2e executor container and the app's backing services. The spike records the real number.

### 2.2 Boot time expectations

- With native KVM (metal), community and Google container-script guidance put a cold boot of a recent x86_64 Google APIs image in the **tens of seconds to ~1.5 min** headless (`-no-window -gpu swiftshader_indirect`). No authoritative 2026 figure was found.
- With nested KVM, AWS and Google both warn of reduced performance (S3, S4). No published C8i/C7i numbers were found. Treat it as **unknown, to be measured**; the spike's pass bar in §6 makes it a go/no-go.
- Without KVM (Graviton virtual, or nested virt left disabled), the emulator falls back to software emulation, which is minutes per boot and unusable for per-run fresh emulators.

### 2.3 Spot vs On-Demand

| | On-Demand | Spot |
|---|---|---|
| Price | List (above) | `c8i.2xlarge` seen at ~$0.17–0.37/h depending on AZ (S8); metal varies |
| Interruption | None | Two-minute notice (S12) |
| Billing | Per second, 60 s minimum (Linux) | Same |
| Fit | Qualification and live demos must not be cut mid-run: a cut run is a skipped/stale result, which the shared result adapter already rejects, but it wastes the run | Fine for spike benchmarking only; unverified whether nested virtualization is offered on Spot |

At ~$0.375/h the Spot saving on the recommended host is a few dollars a month. **Use On-Demand.** Spot is worth revisiting only for a metal host.

### 2.4 Fit with the M1 pattern

- **Per-run fresh emulator:** works on all KVM options. Each run starts an emulator container from a pinned image (`emulatorImageSha256` is already a required installed-manifest field), wipes data, and is destroyed with the run's network. Two parallel runs on a 2xlarge need two KVM-capable containers; `/dev/kvm` is shared safely between processes.
- **Containment:** the emulator container gets `--device /dev/kvm` only (no `--privileged`, no Docker socket), joins the run's `--internal` network, and the guest's DNS is pinned to the sinkhole resolver (`-dns-server`). adb runs from the executor container over that network. IMDS is blocked as in M1 (`HttpPutResponseHopLimit=1` plus the iptables rule). Nested virtualization adds no new network path: the L2 guest's traffic leaves through the emulator's user-mode NAT inside the container, so the M1 egress and IMDS probes apply unchanged and should be re-run against the guest.
- **Build container:** Gradle needs registry egress (Google Maven, Maven Central, Gradle distribution) with no credentials, the same rule M1 uses for npm.
- **Host fleet:** the TEST runner is AL2023 arm64 `m6g.large`. Android needs a **separate x86_64 launch template** (AL2023 x86_64 AMI, `CpuOptions.NestedVirtualization=enabled`). The worker binary is Node, so it runs on either architecture; the executor image needs an amd64 build (multi-arch, or an amd64-only mobile executor). The profile is `linux-x64-android-v1`; the capability schema already allows `host.arch: "x64"` and `kind: "android"`.

## 3. iOS on EC2 Mac

### 3.1 Mac options (us-east-1 Dedicated Host, On-Demand, S9)

| Type | Chip / RAM | $/h | 24 h minimum | Month (730 h) |
|---|---|---|---|---|
| `mac2.metal` | M1, 8 core / 16 GiB | 0.65 | $15.60 | $474.50 |
| **`mac2-m2.metal`** | M2, 8 core / 24 GiB | **0.878** | **$21.07** | **$640.94** |
| `mac-m4.metal` | M4, 10 core / 24 GiB | 1.23 | $29.52 | $897.90 |
| `mac2-m2pro.metal` / `mac-m4pro.metal` | M2 Pro / M4 Pro, 32+ GiB | ~1.56 / ~1.97 (region unconfirmed) | ~$37 / ~$47 | — |

- **Billing (S7):** the Dedicated Host is the billed unit; the instance on it is free. Per-second billing, but the host can't be released until 24 h after allocation (Apple licence). Release = stop/terminate instance → `aws ec2 release-hosts`. Billing pauses during the post-stop scrubbing workflow. No Spot: Mac runs only on Dedicated Hosts.
- **Burst then release:** yes. Allocate, use for the burst, release any time after 24 h. Stopping the instance alone does **not** stop billing; only releasing the host does. A forgotten host costs ~$21/day.
- **Quota:** the roadmap says the Mac quota is already 1. Dedicated Host quotas are per instance family ("Running Dedicated mac2-m2 Hosts" and so on), so confirm **which** family the 1 applies to before allocating. It must match the chosen type.
- **Automation:** `xcodebuild -sdk iphonesimulator` for the candidate build; `xcrun simctl create/boot/install/launch/openurl/privacy/erase/delete` covers launch-app, deep-link, set-permission and restart-app, plus a fresh simulator per run. The recipe contract pins Xcode 16.4 / `iphonesimulator18.5` (`e2e-native-recipes.ts:16`), which needs macOS 15.3+. All three types above run it. Installing Xcode non-interactively needs an Apple developer download (Apple ID), unless the macOS AMI already ships the required Xcode; verify in the spike. **This is a credential-handling question for the owner.**
- **Parallel simulators:** Apple publishes no limit; memory is the ceiling. Estimate **2–3 concurrent simulators on 24 GiB** (`mac2-m2`/`mac-m4`) with an `xcodebuild` build alongside, and 1–2 on 16 GiB `mac2`. Measure in M2.2.
- **Containment gap:** macOS has no Docker `--internal` equivalent for simulators. M2.2 needs a pf-based egress block and sinkhole DNS on the host itself, which is a design item for the M2.2 plan, not for M2.0.

## 4. Monthly cost scenarios (On-Demand list prices above; 1 month = 730 h = 4.33 weeks)

**Scenario A — burst only (qualification + demos):** ~10 h/week Android + one 24 h Mac allocation per month.

| Item | Math | $/month |
|---|---|---|
| Android `c8i.2xlarge` | 10 h × 4.33 = 43.3 h × $0.3748 | 16.23 |
| Mac `mac2-m2.metal` | 24 h × $0.878 | 21.07 |
| **Total A** | | **37.30** |
| (alt.) Android on `c7i.metal-24xl` instead | 43.3 × $4.284 | 185.50 → total 206.57 |

**Scenario B — Android host on during working hours** (8 h × 22 days = 176 h), no Mac.

| Host | Math | $/month |
|---|---|---|
| `c8i.2xlarge` | 176 × 0.3748 | **65.96** |
| `c8i.4xlarge` | 176 × 0.7497 | 131.95 |
| `c5.metal` | 176 × 4.08 | 718.08 |
| `c7i.metal-24xl` | 176 × 4.284 | 753.98 |
| (ref.) `c8i.2xlarge` 24/7 | 730 × 0.3748 | 273.60 |
| (ref.) `c7i.metal-24xl` 24/7 | 730 × 4.284 | 3,127.32 |

**Scenario C — Mac host held all month** (730 h).

| Host | Math | $/month |
|---|---|---|
| `mac2.metal` | 730 × 0.65 | 474.50 |
| `mac2-m2.metal` | 730 × 0.878 | **640.94** |
| `mac-m4.metal` | 730 × 1.23 | 897.90 |

Storage is extra and small: a 100 GiB gp3 root volume is ~$8/month while it exists (gp3 $0.08/GB-month). Mac AMIs need ≥ 100 GiB with Xcode plus runtimes. Data transfer is negligible because the hosts have no egress beyond registries.

## 5. Salvage files named in the roadmap

| File | Found? |
|---|---|
| `android-provider.ts`, `mobile-provider.ts`, `mobile-templates.ts`, `native-artifact-staging.ts`, `ios-provider.ts` | **Not reachable from `PrepLabsAI/Rovara`.** `git log --all` over all 259 fetched remote branches and tags returns nothing for these paths, and branch `codex/rovara-e2e-runtime-automation-20261017`, `c3b2ff95` and `8ca50053` don't exist on this remote. The source branch most likely lives in the ManagedSDLC repo (out of this session's scope). |

What the M1 port already brought into this repo, which M2.1 builds on:

- `packages/contracts/src/e2e-runtime-capabilities.ts`: `android` and `ios` descriptor kinds (`deviceProfileIds`, `deviceKinds` emulator/physical or simulator/physical). iOS requires a Darwin host; Android requires a Linux or Darwin host. `host.arch` allows `x64`. Mobile steps (launch-app, tap, swipe, deep-link, restart-app, set-permission) are in the step enum. **Reusable as is.**
- `packages/contracts/src/e2e-native-recipes.ts`: Android recipe derivation (single `:app` module, AGP 8.7.3, Gradle 8.9 with pinned SHA, JDK 17, SDK 35, build-tools 34, **ABI x86_64**) and an iOS recipe (Xcode 16.4, `iphonesimulator18.5`). Installed-manifest fields include `emulatorImageSha256`. **Reusable; it fixes the Android host to x86_64.**

**Action before M2.1:** whoever starts M2.1 must fetch the five files from the ManagedSDLC runtime-automation branch, and record their real contents and dependencies (`@e2e-dev/mobile` 0.12.0, `agent-device` 0.21.25) in the M2.1 plan. This research could not summarize them.

## 6. Recommendation

1. **Android host: `c8i.2xlarge` On-Demand with nested virtualization, x86_64 AL2023, us-east-1, TEST account only.** It is the cheapest KVM-capable host (~$0.375/h), billed per second, with no minimum beyond 60 s. It keeps the per-run fresh-emulator and Docker `--internal` containment model unchanged, and it matches the x86_64 recipe pin. **Spike pass bar:** `emulator -accel-check` reports KVM usable inside the container; cold boot to `sys.boot_completed=1` in ≤ 120 s; APK install + launch in ≤ 30 s; two concurrent emulators stay stable; egress, IMDS and DNS probes fail from inside the guest as expected.
   **Fallback if the bar is missed:** re-run the same spike on `c7i.metal-24xl` for ≤ 8 h (~$34), then decide between metal-burst-only or a larger nested size.
   **Not recommended:** Graviton (no KVM on virtual Graviton; no supported arm64-host emulator build; conflicts with the x86_64 pin), and Spot (saving too small, and an interruption wastes the run).
2. **iOS: wait.** Do not allocate a Mac host for M2.0. Book it when M2.2 starts. Plan for `mac2-m2.metal` (24 GiB is the memory floor for 2–3 simulators plus a build) in one 24 h burst per qualification or demo, released right after. Don't hold one all month (≈ $641) until there is steady iOS demand.
3. Keep the hosts burst-only (scenario A) through M2.2. Revisit scenario B only if Android runs become routine.

## 7. Owner approvals needed before the hands-on M2.0 spike

| # | Approval | Detail |
|---|---|---|
| O1 | Instance type | `c8i.2xlarge` On-Demand, x86_64, us-east-1, TEST account (`agentxlivetest123`), launched with `CpuOptions NestedVirtualization=enabled`, tagged `DeploymentMode=e2e-qualification`, one at a time, terminated after each session |
| O2 | Fallback type | `c7i.metal-24xl` On-Demand, at most 8 h total, only if O1 misses the spike bar |
| O3 | Spend cap | **$150/month** for M2.0 (scenario A is ~$37; the cap covers the metal fallback day and storage), enforced by an AWS Budgets alert at 50/80/100% |
| O4 | Quota check (no increase expected) | "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances" vCPU quota in us-east-1 must have ≥ 8 vCPU free for O1 and ≥ 96 for O2. Request an increase only if O2 is exercised and the quota is short |
| O5 | Launch template / network | A new x86_64 launch template and security group for the Android host: no inbound, egress only to registries for the build container, IMDSv2 with hop limit 1. Reviewed like the M1 qualification template |
| O6 | Price re-check | Confirm the §2 and §3 prices on the AWS pricing page at approval time (this document could not read it directly) |
| O7 | iOS (deferred to M2.2) | Later: one `mac2-m2.metal` Dedicated Host allocation per burst (≥ $21.07 each, 24 h minimum); confirm the existing Mac quota of 1 is for the `mac2-m2` family (or request it); decide how Xcode is obtained (Apple ID handling) |
