# Computer use: tools and how to make it work well — research findings

> Deep-research run: grokbot lecture insights → mason. Date: 2026-10-18. Model: deepseek-v4.1-flash (max thinking).

## Summary

Two interaction styles coexist: structured targets (accessibility tree / DOM refs) where a usable tree exists, and screenshot-plus-coordinates everywhere else. Click accuracy, not reasoning, is the bottleneck; resolution and coordinate scaling are the highest-impact fixes. Screenshots cost ~1,000–1,800 input tokens each, so the industry pattern is grokbot's: a helper agent owns the screen, prunes screenshots in cache-friendly batches, and the main agent gets a short report. Isolation is non-negotiable: run the desktop in a dedicated container/VM, allowlist the network, keep credentials out of the model, and stop for a human before risky actions. For mason: one `desktop` toolset over the existing `pi-env` target, one supervised Xvfb+Chrome container, one handoff tool — no VM/snapshot machinery.

## Key findings

1. **Two interaction families, one fallback.** Anthropic's computer toolset is 17 members (`screenshot`, `zoom`, clicks, drag, `type`, `key`, `scroll`, `wait`); coordinates are always screenshot pixels; several member calls may arrive per turn as a batch, run in order, and stop at the first failure [1]. Its browser toolset works in the other direction: `read_page` returns the accessibility tree with stable refs (`ref_2`) that survive layout changes, with coordinates as fallback for canvas/cross-origin content [2]. OSWorld exposes both a screenshot and an XML a11y tree (AT-SPI) and found the extra structure helps some models and misleads others [3]. Windows-MCP is the native-OS variant of the structured route: UI Automation trees, with a `use_dom=True` mode for browsers [4].

2. **Grounding is the bottleneck.** OSWorld: humans complete 72.36% of 369 tasks, the best 2024 model 12.24%; failures are bad click coordinates, repetitive actions, unhandled dialogs, weak GUI knowledge [3]. OSWorld-Human: leading agents take 1.4–2.7× more steps than a human trajectory, and planning/reflection calls are 75–94% of latency [5]. UI-TARS (screenshot-only, end-to-end) scored 24.6 on OSWorld at 50 steps vs Claude 22.0 in early 2025 [6].

3. **Structured data is not free.** A11y-tree generation took 3–26 s per step and raised token and step counts for most applications; screenshot + a11y + Set-of-Marks [7] gave the fewest steps for several apps [5]. Treat the tree as an optional rung, not the default.

4. **Resolution and scaling rules are the highest-leverage tuning.** Pre-downscale before sending; the toolset rejects oversized images instead of resizing them [1]. Anthropic's guidance: 1280×720 baseline, 1024×768/1280×720 for desktop apps, 1280×800/1366×768 for web, avoid above 1920×1080; instruction text before the screenshot; `zoom` for small targets [1][8]. Never send native resolution, never go below 960×540, account for Retina's 2× device pixel ratio, and treat click misses as scaling bugs first; tile splitting and grid overlays showed no uplift [8]. OpenAI observes good results at 1440×900 and 1600×900 with `detail: "original"` [9].

5. **Screenshots dominate context; prune in batches.** Roughly 1,000–1,800 input tokens per image; a request with more than 20 images hits stricter per-image limits [1]. Pruning one image per turn destroys the prompt cache, so keep the last 3 and drop 25 turns' worth at once; compact at ~150k input tokens [8]. The reference implementation's defaults are the same shape (`image_prune_min=3`, `image_prune_interval=40`, autocompaction 150k) [10].

6. **Batching beats clicking faster.** `computer_batch`/`browser_batch` cut round trips on mechanical sequences; batching is discouraged where each action depends on the previous screen [8]. Action-level batching in one tool call also matches the API's batch member calls [1].

7. **The reference stacks are small and Docker-shaped.** Anthropic's demo: Docker + a Linux desktop (Xvfb, window manager, Firefox/LibreOffice) with VNC ports mapped [1][11]. OpenAI's recipe: Ubuntu + Xvfb `1280x800x24` + x11vnc + XFCE + xdotool + ImageMagick; actions are `docker exec xdotool …`, screenshots are `import -window root png:-` [9]. Bytebot ships the same shape with a persistent desktop, live view, takeover mode, and password managers [12].

8. **Lifecycle options differ only in what "sleep" preserves.** Firecracker snapshots serialize guest memory and device state to files and resume with a `MAP_PRIVATE` mapping (fast, on-demand paging, but the memory file must stay, and network/vsock connections can be lost); the host must manage, secure, and gc those files [13]. Firecracker sustains 5 microVM mutations per second per host core at 128 MiB RAM [14]. `systemd-nspawn` gives full-OS containers (`--boot`, `--template` = btrfs snapshot at first start, `--ephemeral`, `--volatile`) but no RAM snapshot [15]. `docker pause` is the freezer cgroup and writes no state to disk; `docker commit` snapshots the filesystem, not mounted volumes [16]. QEMU/libvirt is the cheap "sleep with RAM": `virsh managedsave` saves and stops the guest, and the next start resumes from that state [17]. Practical homelab ladder: Docker + Xvfb + named volume → systemd-nspawn/Incus container with btrfs snapshot → QEMU VM with `managedsave` → Firecracker only if microVM orchestration is already your job.

9. **Handoff is a tool plus a screen share.** OpenAI requires the user to take over for password changes and safety barriers, requires confirmation at action time for CAPTCHAs, new software, sending/posting, financial transactions, and system-settings changes, and lets a user's initial prompt pre-approve logins, permission prompts, and uploads; "the model's request to act is not user permission" and confirmation lands before the first risky action in a batch [9]. Anthropic requires confirmation for consequential actions and asks for a dedicated VM, domain allowlists, and no login data in the model [1][8]. The standard live view is noVNC (HTML5 VNC client) with websockify translating WebSocket to TCP [18][19]; Selkies adds WebRTC for higher frame rates [20]. Anthropic's browser demo exposes noVNC on 6080 with VNC on 5900 [21].

10. **pi-env is a command/file/PTY daemon — there is no pixel channel.** Its protocol has file ops, `exec`, `watch`, `pty` (frames ≤16 MiB), and no display or screenshot operation [22]; commands run in their own process group, killed with `killpg` on timeout/abort/cleanup [23]. Screenshots must travel as files or command output, and the desktop stack must be a supervised service on the target, not an `exec`'d command.

## How grokbot does it (from lecture notes)

Three ways to use a computer, in cost order: read the page's structure and click elements directly; click pixels on a 1280×800 screen for desktop apps and system dialogs; stop and ask a person at logins, verification codes, CAPTCHAs, and payments. A separate computer-use helper does the clicking so screenshots never fill the main agent's context; the main agent gets a short report. One screen per active agent, files/tools/logins persist, and the whole computer is a per-user VM snapshotted when idle. This matches the published practice above point for point, except that grokbot puts the "structured vs pixels vs human" ladder inside one helper rather than in the main loop.

## Mason applicability

Already present: the harness/execution split with one `RemoteExecutionEnv` per conversation, locally or over SSH (`src/server/env.ts`); the env exposes shell, files, and PTYs (`vendor/pi/packages/env/README.md`, `docs/protocol.md`); `CodingTools` includes an image-aware `read` (`vendor/pi/packages/durable/src/tools/read.ts`) and tool results may carry `ImageContent` (`vendor/pi/packages/durable/src/harness/tool.ts:105`), with automatic provider-limit resizing in `normalizeToolResultImages` (`vendor/pi/packages/coding-agent/src/utils/tool-result-images.ts`). pi-durable documents a subagent pattern (foreground child conversation owned by the tool task, with a code example) that has no implementation under `src/` — only in `vendor/pi/packages/durable/docs/spec.md` (~line 3272). Mason's web client renders widget iframes (`src/server/extensions/sandboxed-ui.ts`) but drops image parts of tool results: `textOf` keeps only `type: "text"` parts (`src/web/view-types.ts:222`), so a screenshot returned today is invisible to the user.

Missing: any display anywhere; a desktop toolset; a per-tool execution target; a handoff UI. The env manager hardcodes one local-or-SSH choice for all tools (`src/server/env.ts`), so "the agent's computer" as a second target needs a small extension of that factory, not a new subsystem.

Deliberately not building: Firecracker/microVM orchestration, snapshot and restore, per-user VMs, custom pixel streaming, own prompt-injection classifiers, MCP desktop-control servers (mason can add an MCP server later if a target OS needs one — pi already speaks MCP, `vendor/pi/packages/coding-agent/docs/mcp.md`). All of these are dwarfed in value by correct resolution/scaling, a supervised display, and a clean handoff tool.

## Recommended actions

1. **[now]** Add a `computer` target: a small desktop container (Ubuntu + Xvfb `:99 1280x800x24` + a light WM + Chrome + x11vnc/websockify + xdotool + ImageMagick `import`), restarted by systemd/compose, with a named volume for home and browser profile, reachable by SSH so `pi-env` can deploy its daemon there.
2. **[now]** Add a `desktop` extension with the minimum members: `screenshot` (capture to a temp file, return it through the image-aware `read` path), `click`, `move`, `drag`, `type`, `key`, `scroll`, plus a `needsHuman` tool. Coordinates are screenshot pixels; no auto-screenshot after every action.
3. **[now]** Write the ladder into the tool section text, cheapest rung first: shell/file tools → app APIs → structured page control → browser screenshots → desktop → ask the user. The desktop is never the first choice.
4. **[next]** Extend `createRuntimeEnvManager` (`src/server/env.ts`) to route desktop tools to the computer target while shell/file tools stay on the default env; keep one daemon connection per target.
5. **[next]** Handoff: show screenshots in the web client (small change to `ToolRow`/transcript model, capped dimensions, cached), and proxy the container's noVNC through mason's HTTP server behind an owner-only token so the user can watch and take over.
6. **[next]** Implement the documented subagent ("delegate to a helper, report back") as a mason extension and make computer use its first client, so the main conversation never carries screenshots.
7. **[later]** Add `zoom` (crop a region from the full-resolution capture) and coordinate-scaling helpers only if click-miss debugging shows a need; keep the capture and the coordinate space identical until then.
8. **[later]** Multi-screen: one Xvfb display per active computer-use conversation (`:99`, `:100`, …), as grokbot does for parallel agents. Cheaper than per-agent VMs.
9. **[later]** Persistence upgrade path: container stop/start with a volume first; QEMU + `virsh managedsave` if RAM-state sleep is ever actually wanted.
10. **[don't]** Build Firecracker/Kata, snapshot orchestration, per-user VMs, custom streaming, or image-pruning logic in the harness; rely on pi's compaction plus provider-side resizing.

## Open questions

- Which of mason's configured models accept images at all, and do the mason/pi-ai provider paths forward `ImageContent` end to end?
- Does the durable view delivered over Chord carry tool-result image blocks to the browser (needed for screenshot display), or only text?
- AT-SPI accessibility trees inside a container need a session D-Bus and the AT-SPI registry; unverified how reliably that works under Xvfb.
- Whether grokbot's "read the page structure" is a DOM/CDP or an a11y-tree implementation — the notes do not say.
- Current OSWorld leaderboard numbers (the site is JS-rendered) — the last primary numbers here are 2025's.

## Sources

- [1] Anthropic, computer use tool docs — https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool (via web.archive.org snapshot 20260928190641)
- [2] Anthropic, browser use tool docs — https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool (via web.archive.org)
- [3] Xie et al., OSWorld — https://arxiv.org/html/2404.07972v2
- [4] CursorTouch, Windows-MCP — https://github.com/CursorTouch/Windows-MCP
- [5] OSWorld-Human — https://arxiv.org/html/2506.16042v1
- [6] Qin et al., UI-TARS — https://arxiv.org/abs/2501.12326
- [7] Yang et al., Set-of-Mark Prompting — https://arxiv.org/abs/2310.11441
- [8] Anthropic blog, best practices for computer and browser use — https://claude.com/blog/best-practices-for-computer-and-browser-use-with-claude (via web.archive.org)
- [9] OpenAI, computer use integration recipes — https://developers.openai.com/api/docs/guides/tools-computer-use-integration (via web.archive.org)
- [10] Anthropic quickstarts, computer-use-best-practices README — https://raw.githubusercontent.com/anthropics/anthropic-quickstarts/main/computer-use-best-practices/README.md
- [11] Anthropic quickstarts, computer-use-demo README — https://raw.githubusercontent.com/anthropics/anthropic-quickstarts/main/computer-use-demo/README.md
- [12] Bytebot — https://github.com/bytebot-ai/bytebot
- [13] Firecracker, snapshot support — https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md
- [14] Firecracker design — https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md
- [15] systemd-nspawn — https://www.freedesktop.org/software/systemd/man/latest/systemd-nspawn.html
- [16] Docker CLI references: `docker container pause`, `docker container commit` — https://docs.docker.com/reference/cli/docker/container/pause/, https://docs.docker.com/reference/cli/docker/container/commit/
- [17] libvirt `virsh` man page (`save`, `restore`, `managedsave`) — https://libvirt.org/manpages/virsh.html
- [18] noVNC — https://github.com/novnc/noVNC
- [19] websockify — https://github.com/novnc/websockify
- [20] Selkies — https://github.com/selkies-project/selkies
- [21] Anthropic quickstarts, browser-use-demo README — https://raw.githubusercontent.com/anthropics/anthropic-quickstarts/main/browser-use-demo/README.md
- [22] pi-env protocol — `vendor/pi/packages/env/docs/protocol.md`, `vendor/pi/packages/env/README.md`
- [23] pi-env daemon — `vendor/pi/packages/env/daemon/src/exec.rs` (`kill_group`), `vendor/pi/packages/env/docs/semantics.md`
- Repo paths cited inline: `src/server/env.ts`, `src/server/runtime.ts`, `src/server/extensions/sandboxed-ui.ts`, `src/web/view-types.ts`, `src/web/lib/transcript-model.ts`, `vendor/pi/packages/durable/src/tools/read.ts`, `vendor/pi/packages/durable/src/harness/tool.ts`, `vendor/pi/packages/durable/docs/spec.md`, `vendor/pi/packages/coding-agent/src/utils/tool-result-images.ts`, `vendor/pi/packages/coding-agent/docs/mcp.md`
