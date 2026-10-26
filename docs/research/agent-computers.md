# Research: giving mason's tool machine a real computer (Firecracker microVMs and alternatives)

Researched 2026-10-26. Versions cited as found that day: Firecracker **v1.17.0** (released 2026-09-10), nixpkgs firecracker **1.16.1**, Kata Containers **4.3.1**, Cloud Hypervisor **v54.0**, gVisor (rolling), microsandbox **0.7.11**, libkrun 2.0 (pre-release) / stable branch.

Evidence labels used throughout: **[documented]** = stated by the project's own docs/source; **[measured]** = a third party published numbers with a method; **[vendor claim]** = the vendor's marketing or blog; **[inference]** = my reasoning from the above, not stated by any source.

---

## 1. Firecracker today

**Release cadence and current version.**
`v1.17.0` is the latest release (2026-09-10); `v1.16.2` shipped the same day as a patch on the 1.16 line. Releases are "typically every two or three months". The published support table: **v1.17** released 2026-09-10, min end of support 2027-03-10; **v1.16** released 2026-06-03, min end 2026-12-03; **v1.15** supported until 2026-09-10 (v1.17's release ended it). So exactly two minors are live at a time, and the older one is the one you must leave soon. **[documented]** — <https://github.com/firecracker-microvm/firecracker/releases>, <https://github.com/firecracker-microvm/firecracker/blob/main/docs/RELEASE_POLICY.md>

nixpkgs currently packages **1.16.1**, i.e. one minor behind upstream. **[documented]** — <https://github.com/NixOS/nixpkgs/blob/master/pkgs/by-name/fi/firecracker/package.nix>

**Host requirements.** All from `docs/getting-started.md` and `docs/prod-host-setup.md` unless noted. **[documented]**

- Read/write access to `/dev/kvm` from the KVM module (`kvm_intel` or `kvm_amd`). No other device is required for CPU/memory/block/vsock; TAP needs `/dev/net/tun` plus `CAP_NET_ADMIN` (see §2, §4).
- x86_64 or aarch64 Linux only. No 32-bit, no Windows host, no macOS host.
- Host kernels in the validation matrix: **5.10, 6.1, 6.18** (4K pages). 5.10 and 6.1 are at or past end of support; **6.18 is the only live host/guest kernel line** (`v1.16.0` added host 6.18, `v1.16.1` added guest 6.18, min end of support 2028-05-28/2028-06-01). <https://github.com/firecracker-microvm/firecracker/blob/main/docs/kernel-policy.md>
- Guest kernel: an **uncompressed `vmlinux` ELF or (since 1.17, x86_64) a `bzImage`**, plus an **ext4 image** as rootfs. The quickstart downloads both from the project's CI bucket and builds the ext4 image with `mkfs.ext4 -d`. Guest Kconfig list is in `kernel-policy.md`; minimum for a root-block-device boot is `CONFIG_VIRTIO_BLK=y` + `CONFIG_ACPI=y` + `CONFIG_PCI=y` + `CONFIG_KVM_GUEST=y` (x86_64). Amazon Linux publishes the `microvm-kernel-*` trees the project actually tests.
- Cgroups: **v2 strongly recommended**. The snapshot doc calls out "High snapshot restoration latency when cgroups V1 are in use … strongly recommend … cgroups V2". Note the jailer defaults to **cgroup v1** (`--cgroup-version` defaults to `"1"`), so you must pass `--cgroup-version 2` explicitly. <https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md>
- Jailer: optional in the quickstart, recommended for production. It does `unshare()` + `pivot_root()` + `chroot()` + `setuid`/`setgid` into a dedicated uid/gid, optionally joins a pre-existing netns (`--netns`), and writes cgroup files — all operations that assume root-ish privilege at start-up.
- Host tunables the project recommends: no swap, SMT off for tenant separation, KSM off, `kvm.nx_huge_pages=never` or `cgroup_favordynmods` on 6.1+ to avoid the `KVM_CREATE_VM` boot-time regression, `quiet loglevel=1` on the host cmdline (console logging inflated aarch64 restore from 3 ms to 8.5 ms in their measurements).
- No CPU-flag list beyond hardware virtualisation. In practice: VT-x with EPT or AMD-V with NPT, and if the host is itself a VM, nested virtualisation must be exposed.

**x86_64 vs aarch64.** Both are first-class in the release artifacts (`.tgz` per arch) and in CI. Gaps that still exist, all **[documented]**:

- Power-button / `SendCtrlAltDel`: x86_64 only until the unreleased 1.18 (added for aarch64 via a PL061 GPIO controller in the Unreleased changelog). Effect: no graceful external shutdown on aarch64 today; you get `reboot=k`/panic behaviour and a hard kill.
- `pl031` RTC on aarch64 "does not support interrupts", so guest `hwclock` alarms do not work (README "Known issues").
- Snapshots cannot be restored across GICv2/GICv3 guests; aarch64 needs host kernel ≥ 6.4 for the counter-offset mitigation (`KVM_CAP_COUNTER_OFFSET`), and ≥ 6.15 for writable `MIDR`/`REVIDR`/`AIDR` CPU-template registers.
- PCI support (added 1.13, `--enable-pci`) is present on both, but the guest Kconfig requirements differ; the doc still contains a stale line "Firecracker does not support PCI devices" in the ACPI section while the same page documents `--enable-pci`. Treat that sentence as documentation drift, not a capability statement. **[interpretation]**

**Confidence: high** on version, arch, kernel policy, jailer and cgroup facts; **medium** on the exact "CPU flags" question, because the project never enumerates a flag matrix — it only ever says "hardware virtualisation via KVM".

---

## 2. Rootless: Firecracker inside a rootless podman container with `--device /dev/kvm`

Short answer: **it can work, but not as a supported configuration, and the parts that break are networking and the jailer — not KVM.**

**What single-firecracker needs, and what each piece costs in a rootless user namespace**

| Need | Rootless verdict | Evidence |
| --- | --- | --- |
| `/dev/kvm` read/write | Works if the host user already has access (kvm group or ACL). Rootless podman cannot `mknod`, so the device must be bind-mounted or passed; `--device` with a group-owned node (`root:kvm 0660`, e.g. Debian) was reported to silently drop the node, with `-v /dev/kvm:/dev/kvm` as the workaround. | **[documented]** podman issue #16701 <https://github.com/containers/podman/issues/16701>; podman `rootless.md` ("Making device nodes within a container fails … must be run as root") <https://github.com/podman-container-tools/podman/blob/main/rootless.md> |
| Nested virtualisation | **Not needed.** A container shares the host kernel; `/dev/kvm` is the host's KVM. Nested virt only matters if the host is itself a VM. | **[inference]** from the KVM model; consistent with firecracker-in-docker's prerequisites |
| TAP device | Needs `CAP_NET_ADMIN` + `/dev/net/tun`. Inside a rootless podman container you *do* have `CAP_NET_ADMIN` over your own network namespace, so `ip tuntap add` succeeds there; whether traffic can then reach the internet depends on slirp4netns/pasta and your own forwarding rules inside that netns. | **[documented]** firecracker-in-docker: "require access to /dev/net/tun … and the capabilities CAP_NET_RAW and CAP_NET_ADMIN … CAP_NET_ADMIN is the only *additional* capability required … containers may be run as arbitrary non-root users" <https://github.com/fadams/firecracker-in-docker> |
| Userspace networking (passt/slirp) instead of TAP | **Not available.** The Firecracker netdev only accepts a TAP backend; a feature request to allow a userspace backend is open (opened 2026-04-07, still open). | **[documented]** issue #5816 <https://github.com/firecracker-microvm/firecracker/issues/5816> |
| vsock | Uses Firecracker's **userspace** virtio-vsock implementation, which proxies guest `AF_VSOCK` to host `AF_UNIX` sockets — no `/dev/vhost-vsock`, so no extra privilege. (Its own prerequisites section still lists host `CONFIG_VHOST_VSOCK=m`, which contradicts the design section; treat as doc legacy.) | **[documented]** <https://github.com/firecracker-microvm/firecracker/blob/main/docs/vsock.md> |
| Jailer | Effectively unusable rootless: cgroup creation is not namespaced, `setns` into a pre-made netns needs `CAP_SYS_ADMIN` in the netns owner's user ns, and `chown` to an unmapped uid fails. The kernel-level workaround that does work is to make each microVM's network its own namespace and rename the TAP on restore (supported since 1.12, PR #4731) rather than jailer `--netns`. | **[documented]** jailer doc; PR #4731 <https://github.com/firecracker-microvm/firecracker/pull/4731>; **[interpretation]** on which of those steps fail in a userns |
| `CAP_SYS_ADMIN` | Not needed for an unjailed Firecracker. Needed by anything that mounts (jailer chroot, `nsenter` into the jailer netns) and by Kata's Firecracker integration (devmapper thin-pool). | **[documented]** firecracker-in-docker; Kata firecracker profile "A host devmapper thin-pool, which kata-deploy does not create" |

**Is there a documented, reproducible recipe?**

- **Closest to documented:** `fadams/firecracker-in-docker` — a PoC that runs Firecracker inside *unprivileged* Docker containers (not rootless podman specifically), needs `/dev/kvm` + `/dev/net/tun` + `CAP_NET_ADMIN`, and puts the guest's TAP+NAT inside the container's own netns. It describes the architecture and the exact capability set, but it is one person's PoC, not a packaged, tested product. **[documented]** <https://github.com/fadams/firecracker-in-docker>
- **Kata's own position:** "Firecracker has no `rootless` setting; use its jailer instead", and rootless VMM mode exists only for `qemu-runtime-rs` and `clh-runtime-rs`. **[documented]** <https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-run-rootless-vmm.md>
- **Small self-hosted projects** (`clawk`, `pullrun`, `KiCI`, `shed`) all solve it with either `setcap cap_net_admin+ep` on the binary, `--cap-add NET_ADMIN,SYS_ADMIN`, or a rootless *netns owned by the process* and `nsenter`; none is a library you would depend on. **[documented]** e.g. <https://github.com/clawkwork/clawk/blob/main/docs/linux-quickstart.md>, <https://github.com/pullrun/pullrun/blob/5b512c0f/docs/OPERATIONS.md>, <https://docs.kici.dev/operator/orchestrator/firecracker/host-setup/>

**Verdict.** "Works" — yes, for KVM + block + vsock, in a rootless container, with `/dev/kvm` bind-mounted. "Documented and reproducible" — only as a PoC. What breaks in practice is (a) the jailer, (b) any egress path that needs `CAP_NET_ADMIN` on the *host* (a plain TAP+NAT that reaches the host's uplink is the standard recipe and it lives in the host netns), and (c) anything that needs `CAP_SYS_ADMIN` such as cgroup management or mounts. **Confidence: high** on the constraint list, **medium** on the claim that a rootless-podman TAP→pasta path is workable in practice — I found no maintained project that documents that exact combination end-to-end.

---

## 3. Snapshots

**What the API is.** All **[documented]**, from `docs/snapshotting/snapshot-support.md`.

1. `PATCH /vm` with `{"state": "Paused"}` — pauses vCPUs and device emulation. Only after boot.
2. `PUT /snapshot/create` with `{"snapshot_type": "Full"|"Diff", "snapshot_path": …, "mem_file_path": …, "sync_snapshot_files": bool}`. Defaults: `Full`, `sync_snapshot_files: true` (fsync memory + state before returning; setting `false` returns early, data stays in page cache).
3. `PUT /snapshot/load` with `{"snapshot_path", "mem_backend": {"backend_path", "backend_type": "File"|"Uffd"}, "track_dirty_pages", "resume_vm", "huge_pages": "Snapshot"|"None"|"Transparent"|"2M", "clock_realtime"}`. Only **before** the VM is configured. Guest memory is `MAP_PRIVATE`-mapped from the file, faults in on demand, writes go to anonymous CoW pages; the memory file must stay immutable and on disk for the VM's whole life.
4. `PATCH /vm` with `{"state": "Resumed"}`.
5. UFFD backend: `backend_path` is a Unix socket to your own page-fault handler, which can therefore source pages from anywhere (network, compressed store, another host) — `docs/snapshotting/handling-page-faults-on-snapshot-resume.md`.
6. Maintenance tools in the release tarball: `snapshot-editor` (`edit-memory rebase`, `edit-vmstate`) and the deprecated `rebase-snap`.

**What a snapshot contains — and what it does not.**

- Contains: **guest memory** (one file) and **emulated/KVM hardware state** (one `vmstate` file). **[documented]**
- Does **not** contain block devices. Two separate statements: "zero or more disk files (depending on how many the guest had; these are **managed by the users**)" and "the separate block device file components of the snapshot have to be handled by the user". `versioning.md` is blunt: "The block devices attached to the microVM are not considered part of the state and need to be managed separately." **[documented]**
- Useful side effect: snapshot creation **drains and `fsync`s** block devices to the host before returning, regardless of `sync_snapshot_files`. So `pause → snapshot/create → (copy or reflink the ext4 files) → resume` gives you a consistent memory+disk pair, as long as you do the copy while the VM is still paused. **[documented]** + **[interpretation]** on ordering.
- Not in the snapshot: logger/metrics config, MMDS data store contents (config yes, data no), `track_dirty_pages` (must be re-specified on load), and serial-console config.

**Diff snapshots.** Save "at least" the state plus pages dirtied since the last snapshot, in a sparse file; they must be merged onto a base with `snapshot-editor edit-memory rebase` to be generally resumable (exception: diff of a booted VM is immediately resumable). Dirty tracking uses KVM's dirty log if `track_dirty_pages: true` on `/machine-config`, otherwise `mincore(2)` and **swap must be disabled**. **Status: full snapshots are GA since 1.13** ("Changed Firecracker snapshot feature from developer preview to generally available. Incremental snapshots remain in developer preview"); **diff snapshots are still developer preview** and are explicitly coupled to future `guest_memfd` work. **[documented]**

**Restore latency — what is actually published.**

- First-party: Firecracker publishes **no restore-latency figure**. `SPECIFICATION.md` gives boot (`≤125 ms` from `InstanceStart` to `/sbin/init`, serial console disabled, minimal kernel+rootfs) and VMM start (`8 CPU ms`; wall clock "6 ms to 60 ms, typical 12 ms"), and the CI has `test_restore_latency` which only asserts `load_snapshot > 0` and reports through metrics. **[documented]** <https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md>, <https://github.com/firecracker-microvm/firecracker/blob/becc4b74/tests/integration_tests/performance/test_snapshot.py>
- The "4–10 ms" figure often quoted is Marc Brooker's, cited second-hand by a vendor blog, not a Firecracker doc. **[vendor claim, second-hand]** <https://numavm.com/blog/2026-03-10-1-second-boot/>
- Third-party end-to-end measurements (method stated, single host, unverified by me):
  - 176 ms restore / 1,133 ms cold boot from "nothing exists" to "SSH works", Firecracker v1.14.2, Graviton, NVMe+XFS, 256 MiB/2 vCPU Alpine guest; of the 176 ms, 97 ms is host setup (TAP + `systemd-run` spawn), 25 ms `/snapshot/load`, 18 ms resume, 33 ms iptables DNAT, 2 ms readiness. **[measured]** <https://numavm.com/blog/2026-03-10-1-second-boot/>
  - 179 ms p50 / ~203 ms p99 create with no warm pool; ~49 ms `POST /snapshot/load`, ~6 ms resume. **[vendor claim]** <https://www.pandastack.ai/blog/firecracker-memory-snapshots/>
  - 28 ms restore, 1.1 s cold boot, ~3 ms exec, on an AMD Ryzen dev box. **[vendor claim]** <https://dev.to/adwitiya/how-i-built-sandboxes-that-boot-in-28ms-using-firecracker-snapshots-i0k>
  - 42–52 ms warm restore, but **7.5 s** from cold boot to "useful guest" (agent listening). **[vendor claim]** <https://jomcgi.dev/ember/firecracker>
- Consistency: every credible measurement lands the *restore call itself* in the 20–50 ms range and the *whole orchestration* (spawn process, TAP, NAT, readiness) at 150–200 ms. The 4–10 ms number is for the API call only, not a usable guest. **[interpretation]**

**Documented constraints on restore.**

- "Snapshots must be resumed on a software and hardware configuration which is identical to what they were generated on." Cross **host kernel** restore is explicitly "unstable"; the only compatibility table published is `{m5n,m6i,m6a}` 5.10 → 6.1. **[documented]**
- Snapshot format version is fixed per binary (`MAJOR.MINOR.PATCH`); a newer Firecracker generally cannot load an older snapshot without `snapshot-editor`, and the unreleased 1.18 bumps the format to `13.0.0` for the PL061 GPIO controller — i.e. **snapshot upgrade = recreate snapshots**. **[documented]**
- TAP devices, disk backing files and the vsock UDS "should be set up and accessible … at the same relative paths to the new Firecracker process as they were to the original". Since 1.12 you can rename the host TAP on restore; before that, per-clone netns with identical TAP names was the only way.
- vsock is **reset** across snapshot/restore: in-flight connections are closed, listen sockets survive with an updated CID. Network connections are not preserved; packet loss expected.
- Guest wall clock continues from snapshot time; either fix it in the guest or use `clock_realtime: true` (host ≥ 5.16 and a TSC-based clock on the snapshotting host).
- cgroup v1 → high restore latency (see §1).
- Do not snapshot during early guest boot (VMGenID interrupt may not be handleable → crash).
- **vhost-user block devices cannot be snapshotted at all**: "At the moment, snapshotting is not supported for microVMs that have vhost-user devices configured. An attempt to take a snapshot of such a microVM will fail." (vhost-user-blk has been in developer preview since 1.7.) **[documented]**
- Ballooning: I could **not** find any documented "no ballooning with snapshots" constraint in the 1.17 docs — `docs/balloon.md` has no snapshot section, and `docs/memory-hotplug.md` explicitly describes snapshots *with* hotplug memory (unplugged areas appear as sparse holes; the UFFD handler must cover the whole hotpluggable range). If the "no ballooning" claim in the brief came from an older doc or a vendor, it is not supported by current primary sources. **[missing evidence]**

**Confidence: high** on API shape, contents, block-device exclusion, vhost-user exclusion and the identical-configuration rule; **medium** on absolute latency numbers, which are all third-party.

---

## 4. Networking

**How a microVM gets the network.** Firecracker supports exactly one netdev backend: **TAP** ("Currently, Firecracker supports only a TUN/TAP network backend with no multi queue support") plus, orthogonally, **vsock** for host↔guest channels. There is no userspace/slirp/passt backend (issue #5816, open). **[documented]** <https://github.com/firecracker-microvm/firecracker/blob/main/docs/network-setup.md>

The three documented topologies: **NAT-based** (guest reachable only outbound through the host's uplink), **bridge-based** (guest on the LAN), **namespaced NAT** (one netns per clone, needed when several clones share a snapshot's IP/MAC). **[documented]**

**Simplest way to give the agent ordinary egress while keeping it away from host services** — the documented NAT recipe, tightened:

1. One TAP per VM in its **own network namespace** (`ip netns add fc-<id>`; `ip netns exec … ip tuntap add vmtap0 mode tap`), /30 per VM (`172.16.x.y/30`), host side `.1`, guest `.2`. Namespacing now costs nothing extra and buys you clone-safe IPs, per-VM firewall state, and no TAP clutter on the host.
2. `net.ipv4.ip_forward=1` **inside that netns** (namespaced sysctl) and in the host netns if the veth uplink crosses it.
3. NAT with `nft`: `postrouting … oifname <uplink> masquerade`, `forward … iifname vmtap0 oifname <uplink> accept`.
4. **Default-deny forward**, then allow only the uplink. Explicitly drop RFC1918/loopback/link-local destinations and the host's own address, and drop the cloud metadata address — Firecracker's own production doc recommends exactly this shape ("Firecracker does not perform any network traffic filtering … Firewall rules should therefore be implemented on the host", with an IMDS drop example). `<https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md>`
5. DNS: either resolve in the guest against a public resolver, or run a resolver bound to the TAP address only.

That gives `git clone`, `gh`, `curl` over TLS with no inbound reachability, no host filesystem reach, and no path to the host's other services (the host is only a router; its own listening sockets are not routed to because the guest's only next hop is the TAP, and DNAT/forward rules never touch `INPUT`). **[documented recipe] + [interpretation]** on the isolation argument.

**Control channel.** Use **vsock**, not SSH-over-TAP, for the agent-facing daemon: it survives having no guest IP, needs no port forwarding, needs no privileges, and is the path Kata and every FC-based sandbox product use. Cost: vsock is reset on snapshot/restore, so the host side must reconnect. **[documented]**

**What is not possible / not documented.** No passt/slirp netdev; no multiqueue TAP; no per-VM `macvtap` shortcut; no IPv6 in the quickstart (you must adapt the rules); and Firecracker will not create TAPs for you on restore — you must have a TAP with the configured name (or rename via the 1.12+ restore option) before `PUT /snapshot/load`. **[documented]**

**Confidence: high.**

---

## 5. Filesystem for an agent's computer

**What Firecracker supports.**

| Option | Supported? | Notes |
| --- | --- | --- |
| Block device backed by a host **file** (virtio-blk) | **Yes** | `PUT /drives/{id}` with `path_on_host`; Sync/Async IO engines; rate limiting; `discard` opt-in (1.17); online resize + rescan. Rootfs is normally a raw **ext4 image**. |
| **virtio-pmem** on a host file | Yes, since 1.14 | Memory-mapped host file exposed as `/dev/pmem0`, can be rootfs, DAX-capable. Writer-visible = a shared host file, not a directory. |
| **virtiofs** (vhost-user-fs) | **No** | Maintainer, 2023: "virtio-fs support is not currently on our roadmap"; the original "Host Filesystem Sharing" issue was closed in 2020 as "not a path we need to take Firecracker on"; the virtio-fs PR was closed unmerged; a generic vhost-user frontend PR (#5773) is closed unmerged. **[documented]** <https://github.com/firecracker-microvm/firecracker/issues/1180> |
| **9p** | **No** | Rejected early for security; never re-added. Same issue thread. |
| **vhost-user block** | Yes, developer preview since 1.7 | Out-of-process backend over UDS. **Cannot be snapshotted.** Useful for exotic backends, not for sharing a directory. |

Corroboration from a NixOS-adjacent project that supports eight hypervisors: `microvm.nix`'s hypervisor table lists Firecracker's restriction as "**no 9p/virtiofs shares**", while qemu, cloud-hypervisor, crosvm and vfkit do support shares. **[documented]** <https://github.com/microvm-nix/microvm.nix/>

**Costs of the three approaches (my synthesis, informed by the above).**

- **ext4-in-a-file (block).** Pros: the only filesystem Firecracker actually supports for a writable root; snapshot-friendly (it is a file you can copy/reflink); you control size, discard and rate limits. Cons: fixed size (growable online, but you must `truncate` + rescan), no host visibility — the host cannot `ls` the agent's files, and there is no way to edit `~/dev/clinical-compass` from the host while the VM runs. **[documented]** + **[inference]**
- **virtiofs.** Best semantics for a shared directory (host is the source of truth, live, POSIX, page-cache coherent-ish, `cache=never|always|auto`, xattrs, no double copy). Requires **virtio-fs-capable VMM** (QEMU with virtiofsd, Cloud Hypervisor, libkrun, crosvm), a `virtiofsd` daemon per share, and `virtiofsd` wants `cap_sys_admin` unless run with `--sandbox=chroot`/user-namespace options. Not available on Firecracker at any price. **[documented]** Cloud Hypervisor `docs/fs.md` (`sudo setcap cap_sys_admin+epi target/release/virtiofsd`) <https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/fs.md>
- **9p.** Universally available (QEMU `virtio-9p-device` works on virtio-mmio, so even on QEMU's `microvm` machine), simple, and slow — per-request round trips, no mmap coherence, poor with many small files, and a long history of security bugs. Fine for `/nix/store` read-only; bad for an Obsidian vault being edited on both sides. **[documented]** for availability; **[inference]** for the performance judgement, based on microvm.nix's default of 9p only for the read-only store share.

**Can a host directory be shared live?** Not with Firecracker natively. The honest options, in order of how much I would trust them:

1. **Change the VMM** to one with virtiofs (Cloud Hypervisor or libkrun). This is the only option that gives real live sharing plus snapshot/restore. **[inference]**
2. **Serve the directory over the TAP** from the host (NFSv4 or SMB inside the VM, bound to the TAP address only, `root_squash`, no other exports). Live, portable across any VMM, survives snapshot/restore if the guest remounts (soft mounts, `nfsvers=4.2`, `timeo`). Costs: a second network service, hard-to-reason-about locking (Obsidian/SQLite care about this), and an extra privilege boundary you must firewall. **[inference]** — no primary source prescribes it for Firecracker; it is the standard workaround in FC-based products.
3. **A vsock file service** (host serves file RPC; guest mounts a FUSE filesystem over it). Under your control, no network exposure, but you are writing a distributed filesystem and FUSE in the guest is slow for the Obsidian use case. **[inference]**
4. **Sync, not share** (in-guest git remote + a file-sync daemon). Simplest and the least surprising for an agent that also runs `git`; loses "host edits visible immediately". **[inference]**

**Confidence: high** that Firecracker cannot share a host directory; **medium** on relative performance claims (no first-party 9p-vs-virtiofs benchmark was fetched).

---

## 6. Alternatives, against the same requirements

Requirements as stated: snapshot/restore, rootless, NixOS host, host-directory sharing, real Linux userland, GPU-less.

| Option | Real VM? | Snapshot / restore | Rootless | Host-dir sharing | Maturity / who uses it | Fit |
| --- | --- | --- | --- | --- | --- | --- |
| **Firecracker 1.17** | Yes (KVM) | Full GA, diff dev-preview; block devices copied by you; vhost-user-blk not snapshottable | Only unjailed, inside a userns, with `/dev/kvm`; jailer wants root; TAP needs `CAP_NET_ADMIN` somewhere | **No** | Very high; AWS Lambda/Fargate; Kata `kata-fc`; E2B and Morph build on it | Good for isolation + snapshot; **fails host-dir sharing and clean rootless** |
| **Cloud Hypervisor 54.0** (2026-10-14) | Yes | Yes: `ch-remote snapshot`/`restore`, `config.json` + `state.json` + `memory-ranges`, `memory_restore_mode=ondemand` via userfaultfd; **disks not included** | Supported: `clh-runtime-rs` is one of the two rootless VMMs in Kata; CH itself ships seccomp + **Landlock** self-sandboxing | **Yes**: virtiofs via `virtiofsd` (vhost-user-fs) | High and rising; used by Kata, Arrakis, many sandbox startups | **Best single-VMM fit** |
| **QEMU `-machine microvm`** | Yes | `savevm`/`loadvm` or migration-to-file golden snapshots; "**no live migration across QEMU versions**"; no hotplug | Yes, if `/dev/kvm` accessible and you avoid TAP (user-mode net) | 9p yes (virtio-mmio); **virtiofs needs PCI, so no** on `microvm` | Very high (QEMU itself) | Fine if 9p is acceptable; virtiofs forces standard `q35`/`virt` and loses the fast-boot shape **[documented]** <https://www.qemu.org/docs/master/system/i386/microvm.html> |
| **Kata Containers 4.3.1** | Yes | No FC snapshots. VM **templating** (factory) exists on Cloud Hypervisor and Dragonball (4.1.0+); that is "boot once, clone many", not general snapshot/restore | Only via `runtime-rs` (QEMU, CLH). Firecracker path is Go-runtime only and Go runtime is deprecated (no removal before 5.0, forecast 2028) | Yes (virtiofs, and virtio-9p) | Very high; Kubernetes-first | Great as a pod runtime; **heavy** as a single-user backend, and its FC path is the legacy one |
| **gVisor (`runsc`)** | **No** — userspace kernel | Yes: `runsc checkpoint --image-path` / `restore`, direct-I/O, background restore; CRIU-like but gVisor-native | Yes (documented rootless containers) | Yes (gofer/FUSE, `--fs`), plus bind mounts | High; Modal (historically), GKE Sandbox | Not a real VM; syscall coverage is the risk for `gh`/`git`/compilers |
| **libkrun / crun `--runtime=krun`** | Yes | libkrun itself has no snapshot API; **microsandbox** builds snapshot/fork on top | **Yes** — designed for unprivileged use; `crun` krun mode is an OCI runtime; used by Podman | virtiofs | Medium (libkrun 2.0 in development; `crun`/Podman integration real) | The "rootless microVM with virtiofs" primitive; snapshot tooling is young |
| **microsandbox 0.7.11** (2026-10-24) | Yes (libkrun + smoltcp) | Disk snapshots (default) + **full** (memory+processes) snapshots, **local only** for full; fork with `--cow-mem` | Yes (per-sandbox process, no daemon, KVM/HVF) | virtiofs mounts and host-directory bind rootfs | Young but active; single vendor (`superradcompany`) | **Closest off-the-shelf match** to "agent's computer": snapshots + virtiofs + no root |
| **Arrakis** | Yes (Cloud Hypervisor) | snapshot + restore, "backtracking" API/MCP | Root needed for TAP on a bridge + iptables ("removing the root dependency is being worked on") | Overlayfs rootfs built from a Dockerfile; no live host dir documented | ~890 stars, AGPL, one maintainer | Good ideas, not a dependency |
| **Lima / colima** | Yes | `limactl snapshot create/apply/delete/list` — implemented **only in the qemu driver** (vz driver has no SnapshotManager) | Runs as your user; needs `/dev/kvm` | Yes (sshfs/9p/virtiofs mounts) | High (developer tool) | Convenient dev harness, not an agent runtime |
| **systemd-nspawn** | **No** (namespaces) | No VM snapshot; `machinectl` clone/shell only; CRIU-based `systemd-run` checkpointing is not a product feature | **No** — needs root | Yes (bind mounts) | Very high (systemd) | Fails the snapshot + rootless requirements |
| **E2B** | Yes (Firecracker) | Pause/resume preserves **filesystem and memory**; templates; forking; filesystem-only snapshots | Self-hosted infra needs KVM + privileged network | No live host dir | High; widely used; open-source infra | Managed or self-host, but not "one VM per agent on my NixOS box" without work |
| **Daytona** | Mixed: container sandboxes + VM sandboxes | Container = cold (fs only); VM = hot (fs + memory); full snapshots region-pinned | Self-hosting wants a VM-capable host | Not the model | Public repo **archived** (GitHub confirms `archived: true`; last push 2026-07-24), development moved private | Not a safe dependency |
| **Modal** | Both: gVisor containers, and **VM Sandboxes GA 2026-10-01** (`runtime="vm"`) | Memory snapshots via gVisor checkpoint/restore: experimental, 7-day TTL, same instance type required, snapshotting terminates the source | Managed only | Yes (images/mounts) | High | Managed platform, not a self-host option |
| **Morph** | Yes (Firecracker) | Snapshot + **fork** from a snapshot; the standout feature | Managed only | No | Small, closed infra | Managed only |
| **Anthropic `sandbox-runtime` (`srt`)** | **No** — bubblewrap (Linux) / `sandbox-exec` (macOS) + proxy allowlist | No snapshots | Yes | Yes (it *is* the host filesystem, filtered) | Beta research preview, shipped for Claude Code | Solves "restrict what the agent touches", not "give it a computer" |

Additional notes that matter for a decision:

- **Kata's Firecracker path** now requires a host **devmapper thin-pool** (profile `try-kata-fc.values.yaml`), is Go-runtime only, and is not rootless. **[documented]** <https://kata-containers.github.io/kata-containers/releases/4.3.0/> and <https://kata-containers.github.io/kata-containers/kata-deploy-runtimeclasses/>
- **`firecracker-containerd`** is *not* dormant — GitHub shows `archived: false`, last push 2026-10-21, ~2.97k stars — but it is a containerd shim plus a devmapper snapshotter — host-level infrastructure for a Kubernetes-style node, not a library for a single-user backend. I did not evaluate it further, because it solves orchestration, not the filesystem or rootless problems. **[documented]** repo metadata, <https://github.com/firecracker-microvm/firecracker-containerd>
- **Modal's VM Sandboxes** exist because "agents just want a computer" — running Docker, local DBs, graphical environments. Their own framing is worth reading as validation of the requirement, and as a warning: they kept gVisor and added a VM runtime rather than replacing it. **[vendor claim]** <https://modal.com/blog/vm-sandboxes-agent-computers>

**Confidence: high** on Firecracker, Cloud Hypervisor, Kata, gVisor, QEMU, Lima, nspawn, libkrun/microsandbox mechanics; **medium** on Daytona/Morph/E2B details (vendor docs only); **low** on anything about future roadmaps.

---

## 7. NixOS specifics

- **Packaging.** `pkgs.firecracker`, version **1.16.1**, built from source with `rustPlatform.buildRustPackage`, `cargoBuildFlags = [ "--workspace" ]` (so `jailer`, `snapshot-editor`, `cpu-template-helper` come with it). No `firecracker` NixOS module: `nixos/modules/virtualisation/` contains `qemu-vm.nix`, `libvirtd.nix`, `incus.nix`, `kubevirt.nix`, `nspawn-container/`, `podman/`, … and **no** `firecracker.nix`. **[documented]** <https://github.com/NixOS/nixpkgs/blob/master/pkgs/by-name/fi/firecracker/package.nix>
- **`/dev/kvm` on NixOS.** NixOS reserves GID **302** for group `kvm` with the comment "default udev rules from systemd requires these" (`nixos/modules/misc/ids.nix`), so the stock systemd udev rule gives `/dev/kvm` `root:kvm 0660`. There is no option that adds you automatically — the operator does `users.users.<name>.extraGroups = [ "kvm" ]` (or `setfacl -m u:$USER:rw /dev/kvm`). **[documented]** for the GID reservation; **[inference]** for "no option adds you" (based on the module listing above not containing one).
- **NixOS-friendly orchestration exists, but not as a NixOS module in nixpkgs:** **microvm.nix** (`github:microvm-nix/microvm.nix`) provides `microvm.hypervisor = "firecracker" | "cloud-hypervisor" | "qemu" | …`, `microvm.vms.<name>` declarative definitions, a `microvm@.service` per VM, `microvm-tap-interfaces@.service`, `microvm-virtiofsd@.service`, a `microvm` CLI, balloon support, and read-only root with squashfs/erofs. Its documented Firecracker restriction is decisive for §5: "**firecracker — no 9p/virtiofs shares**"; only qemu, cloud-hypervisor, crosvm and vfkit get shares. **[documented]** <https://microvm-nix.github.io/microvm.nix/>, <https://github.com/microvm-nix/microvm.nix>
- **Must the guest rootfs be Nix-built?** No. Firecracker takes any ext4 image and any uncompressed kernel/`bzImage`; the upstream quickstart downloads a prebuilt kernel + Ubuntu squashfs from CI and `mkfs.ext4 -d`s it. What you *cannot* do is share the host `/nix/store` into a Firecracker guest (no 9p/virtiofs), so a Nix-built guest must bake its store into the image (or the image carries a normal FHS userland). With microvm.nix + qemu/cloud-hypervisor/crosvm the store is shared read-only over 9p/virtiofs, which is why those paths are much cheaper on NixOS. **[documented]** quickstart; **[inference]** on the "bake the store in" consequence.

**Confidence: high.**

---

## 8. Cold-start budget

| Stage | Firecracker's own number | What it excludes |
| --- | --- | --- |
| Firecracker process start → API socket | 8 CPU ms target; wall clock 6–60 ms, typically **12 ms** | Process spawn (`fork/exec`), `systemd-run`, cgroup setup, log pipe creation |
| `InstanceStart` → guest `/sbin/init` | **≤ 125 ms** (vendor/CI claim, enforced in CI) | Serial console disabled; minimal kernel + rootfs; **excludes** your real rootfs, your init, sshd/agent start, DHCP, DNS, any tool warm-up |
| Full cold boot to "usable guest with tools" | **no first-party number** | Third parties measure **~1.1 s** (Alpine, minimal) to **7.5 s** (real agent + toolchain) — **[measured]/[vendor claim]** |
| `PUT /snapshot/load` | no first-party number; third parties **25–49 ms**; "the call returns in 25 ms regardless of VM memory size" because it is `mmap` | Page faults on first touch of each page (deferred, so the *first* guest instructions after resume pay them); disk/TAP/socket existence checks |
| `PATCH /vm` resume | no first-party number; **6–18 ms** reported | vCPU actually running user code |
| Whole restore pipeline (spawn TAP, spawn FC, load, resume, NAT, readiness) | **150–200 ms** across two independent third-party pipelines | Your own control-plane RTT, auth, the agent's first model call |

**The practical floor for "agent wakes up, has its tools, answers".** On a NixOS host with NVMe:

- VMM + load + resume + TAP + NAT: **~40 ms optimistic, ~180 ms realistic** (third-party). **[measured]**
- Guest-side readiness for a *restored* snapshot: near-zero if the agent process was already listening when the snapshot was taken (tens of ms), because the guest is mid-execution; but vsock/TCP connections are dead and must be re-established, and the clock jumped. **[documented]** constraints + **[inference]** on the reconnect cost.
- Dominant term after that is the model: a single tool-calling round trip is hundreds of ms to seconds, and `git clone` of a real repo is 0.3–3 s. Optimising below ~150 ms of restore is therefore invisible. **[inference]**
- Realistic target to design against: **p95 < 400 ms from "wake this agent" to "first tool call executing"**, with the memory file already paged in by the kernel after the first restore of the day (page cache keeps it hot; a cold host needs an extra few hundred ms of read I/O proportional to the *touched* working set, not the whole RAM image, because of on-demand paging). **[inference]**

**Confidence: medium.** The only first-party number is the 125 ms boot claim; everything end-to-end is third-party and host-specific.

---

## 9. What this means for the design

1. **The requirement set and Firecracker are in tension on two hard points, not one.** Firecracker cannot share a host directory (§5: no virtiofs, no 9p, "not on our roadmap") and has no clean rootless story (§2: jailer wants root, TAP wants `CAP_NET_ADMIN`, no userspace netdev). Snapshot/restore — the thing Firecracker is actually best at — is the one requirement it meets completely. If `~/dev/clinical-compass` and the Obsidian vault must be live host directories, **Firecracker is the wrong VMM**; pick Cloud Hypervisor (virtiofs + snapshot/restore + a rootless path Kata already exercises) or libkrun/microsandbox (rootless + virtiofs + snapshots, younger).

2. **If you keep Firecracker, split the problem at the filesystem boundary.** Guest root and `/workspace` on an ext4 file (snapshottable, reflinked, no host visibility); the two host directories reached over the network or over vsock from a small host-side service. Network FS (NFSv4 bound to the TAP address, `root_squash`, no other exports) is the boring, working answer; a vsock FUSE service is the "no network exposure" answer at the cost of writing a filesystem. Do **not** try to fake it with virtio-pmem on a single file — that is a shared *file*, not a directory, and there is no coherence protocol.

3. **Snapshot discipline is yours to define, and it is cheap if you get the order right.** `PATCH /vm Paused` → `PUT /snapshot/create` (which drains and fsyncs your block files) → copy or `cp --reflink=always` the ext4 file(s) → `PATCH /vm Resumed`. That yields a consistent memory+disk pair with no guest quiescing. Budget disk as `mem_size + disk_size + slack` per snapshot, keep the memory file immutable for the restored VM's lifetime, and treat snapshot files as **secrets** — Firecracker's own doc says snapshot files are trusted input, CRC-checked only against accidental corruption, and every snapshot contains the guest's keys and tokens.

4. **Never restore one snapshot twice without a plan for uniqueness.** Firecracker calls resuming the same state twice insecure: VMGenID reseeds the guest kernel PRNG on resume (Linux ≥ 5.18), but "unique identifiers, cached random numbers, cryptographic tokens … **will** still be replicated". One snapshot per agent-life, or a per-restore credential injection step (microsandbox's "credentials stay on the host" model is the right shape). **[documented]**

5. **Networking: one netns per VM, TAP + nft NAT to the uplink only, default-deny forward, and vsock for the control plane.** That is the documented recipe and it satisfies "ordinary egress, no host services". It costs `CAP_NET_ADMIN` in whatever namespace owns the TAP — which is exactly the privilege that a rootless-with-only-`/dev/kvm` deployment does not have. If "rootless" means "the mason process holds no capabilities on the host", Firecracker + NAT is out and you need libkrun/passt-style userspace networking.

6. **Cold start is not the constraint; startup of the agent's world is.** 125 ms is kernel-to-init on a minimal image. Your agent needs a userland with `git`, `gh`, `curl`, node/python, its skills and its `pi-env` daemon — that is 1–8 s cold. Snapshot after everything is listening and the number collapses to ~200 ms. So the design decision is really "when do we snapshot, and what is allowed to be stale afterwards" (network connections, clock, vsock, mounts, credentials).

7. **NixOS: expect to build the plumbing.** `pkgs.firecracker` is 1.16.1 with no module; microvm.nix gives you systemd units, TAP setup and a declarative shape but explicitly denies Firecracker any share; a Nix-built guest must carry its own `/nix/store` in the image. If you want the Nix-native path (shared read-only store, virtiofs shares), that path is qemu or cloud-hypervisor, not Firecracker.

8. **Concrete recommendation.** Prototype **Cloud Hypervisor + virtiofsd + snapshot/restore** as the primary, with **Firecracker + vsock file service or NFS** as the fallback if CH's snapshot maturity or memory overhead disappoints, and keep **microsandbox** as the "buy, don't build" reference implementation to measure against. All three satisfy "real Linux userland, GPU-less, snapshot, NixOS host"; only the last two differ on rootless and host-dir sharing, and only CH satisfies both.

---

## Sources

**Kept — primary (Firecracker)**

- Firecracker releases & CHANGELOG — <https://github.com/firecracker-microvm/firecracker/releases>, <https://github.com/firecracker-microvm/firecracker/blob/main/CHANGELOG.md> — current version, snapshot GA/diff-preview status, vhost-user-blk limitation, aarch64 gaps.
- `docs/getting-started.md` — <https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md> — host prerequisites, rootfs/kernel shape, `setfacl`/kvm group.
- `docs/prod-host-setup.md` — <https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md> — cgroup v2, egress filtering, IMDS drop, swap/KSM/SMT, restore-latency-vs-console anecdote.
- `docs/kernel-policy.md` — <https://github.com/firecracker-microvm/firecracker/blob/main/docs/kernel-policy.md> — the 5.10/6.1/6.18 support matrix and Kconfig list.
- `docs/snapshotting/snapshot-support.md`, `versioning.md`, `network-for-clones.md` — API shapes, contents, constraints, per-clone networking.
- `docs/vsock.md`, `docs/network-setup.md`, `docs/pmem.md`, `docs/api_requests/block-vhost-user.md`, `docs/memory-hotplug.md`, `docs/jailer.md` — mechanism detail.
- `SPECIFICATION.md` — <https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md> — the 125 ms boot claim and its caveats, 8 CPU ms VMM start, ≤5 MiB overhead.
- Issue #1180 "Host Filesystem Sharing" (closed 2020) — <https://github.com/firecracker-microvm/firecracker/issues/1180> — the virtiofs/9p refusal, with maintainer comments.
- Issue #5816 "Userspace networking (passt/slirp)" (open, 2026-04-07) — <https://github.com/firecracker-microvm/firecracker/issues/5816> — TAP-only netdev, rootless motivation.
- PR #4731 — <https://github.com/firecracker-microvm/firecracker/pull/4731> — TAP rename on restore (1.12).

**Kept — primary (everything else)**

- nixpkgs `firecracker/package.nix` and `nixos/modules/misc/ids.nix` — version 1.16.1; kvm GID 302 reserved for systemd udev.
- microvm.nix — <https://github.com/microvm-nix/microvm.nix>, <https://microvm-nix.github.io/microvm.nix/> — hypervisor support matrix incl. "firecracker — no 9p/virtiofs shares", declarative VM + systemd units.
- Cloud Hypervisor `docs/snapshot_restore.md`, `docs/fs.md`, `docs/landlock.md`, releases — <https://github.com/cloud-hypervisor/cloud-hypervisor> — snapshot file set, ondemand uffd restore, virtiofs/virtiofsd, sandboxing.
- Kata Containers `docs/how-to/how-to-run-rootless-vmm.md`, 4.3.0/4.3.1 release notes, RuntimeClasses page — rootless matrix, Firecracker's devmapper requirement and Go-runtime-only status.
- QEMU `microvm` machine doc — <https://www.qemu.org/docs/master/system/i386/microvm.html> — no PCI/ACPI, ≤8 virtio-mmio, no cross-version live migration.
- gVisor checkpoint/restore and rootless docs — <https://gvisor.dev/docs/user_guide/checkpoint_restore/>.
- Lima `pkg/driver/driver.go` + `cmd/limactl/snapshot.go` + qemu/vz driver files — snapshot manager exists; qemu implements it, vz does not.
- libkrun README and `crun` `krun.1.md` — unprivileged OCI-runtime integration, TSI networking, virtiofs.
- podman `rootless.md` and issue #16701 — device-node limits, `/dev/kvm` workaround.
- microsandbox docs (snapshots, security model, filesystem) + README — disk/full snapshots, virtiofs mounts, network policy, libkrun+smoltcp.
- Anthropic `sandbox-runtime` README — bubblewrap/seatbelt, proxy allowlist, no VM/snapshot.
- Arrakis README/detailed README — Cloud Hypervisor, snapshot/restore, root-for-iptables.
- E2B, Daytona, Modal, Morph docs — snapshot semantics and limits (§6).

**Rejected or deprioritised**

- `numavm.com`, `pandastack.ai`, `dev.to`, `jomcgi.dev`, `sandboxdeployment.com` — used only as *third-party measurements* of latency, clearly labelled; all are vendor/practitioner blogs with small-n benchmarks and no independent replication. None is used for a capability claim.
- `temps.sh` / `morphllm.com` comparison posts — SEO-shaped listicles; used only as pointers, every fact re-checked against the vendor's own docs.
- `firecracker-in-docker`, `clawk`, `pullrun`, `kici`, `shed` — valuable as evidence of what a rootless recipe *requires*, not as dependencies (single-maintainer PoCs/small projects).
- `firecracker-containerd` — active (last push 2026-10-21) but aimed at containerd/Kubernetes, which is not mason's shape; deprioritised after checking the repo metadata.
- Kata 4.2 docs snapshot — superseded by 4.3.1.

---

## Missing evidence / open questions

1. **No first-party restore-latency figure.** Firecracker only asserts boot time; every restore number in §3 is third-party. If the decision hinges on 30 ms vs 180 ms, measure it on the actual host with a real rootfs.
2. **No reproducible, maintained "Firecracker in rootless podman" recipe.** I could not find one end-to-end (KVM + TAP + egress inside a user namespace) from a project anyone maintains; the pieces exist separately. Treat "works" as "KVM and vsock work, networking needs privilege somewhere".
3. **The "no ballooning with snapshots" constraint is unsupported** by the 1.17 docs (see §3). Either it is folklore, or it refers to a much older release. Worth asking whoever put it on the table.
4. **Cross-version snapshot portability** is only partly documented: format version is fixed per binary, `snapshot-editor` can rewrite some state, but I found no statement that a 1.17 snapshot loads on 1.18. Plan for "same binary for create and load".
5. **Guest-side readiness cost after restore** (how long before `pi-env`/sshd is actually serving again, and what breaks in an already-open vsock session) is undocumented; it must be measured with mason's real guest image.
6. **Obsidian-specific risk**: a live vault shared over virtiofs or NFS with writes from both sides is a coherence and locking question I could not answer from primary sources; SQLite-backed plugins and `.obsidian/workspace.json` rewrites are the likely failure mode.
7. **Cloud Hypervisor snapshot maturity**: CH documents `snapshot`/`restore` and `memory_restore_mode=ondemand`, but I did not find a published CI-enforced latency/compat policy comparable to Firecracker's SPECIFICATION. Worth a targeted look before committing.
