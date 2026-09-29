# What Scheme does

[Home](README.md) · [Setup](INSTALL-HOST.md) · [Configuration](CONFIGURATION.md) · [Troubleshooting](TROUBLESHOOTING.md)

Scheme is a browser dashboard for terminals on a computer you control. The **host** runs Scheme, stores the projects, and runs any optional assistants. The **viewing device** supplies the browser, screen, and typing. It does not need its own Node.js, agent, or local model installation.

The public dashboard contains **Terminal** and **Connect**. It does not include unrelated applications or require another repository.

## Choose your terminal

| Session type | What runs on the host | What you need |
|---|---|---|
| Shell | Your normal command shell | Scheme's required host tools; no AI account. |
| Claude Code | Your installed Claude Code CLI | The CLI, a supported account or API setup, and your own sign-in. |
| Codex | Your installed Codex CLI | A current CLI with `--no-daemon` support, a supported account or API setup, and your own sign-in. |
| Local LLM | Claude Code connected to a local Ollama endpoint | The Claude Code program, Ollama, and a downloaded compatible model that fits your hardware. |

Cloud access, billing, model availability, and usage limits belong to your own provider account. Scheme does not provide credentials or a subscription. The Local LLM wrapper performs a preflight check; it stops when the local endpoint or selected model is unavailable. It does not silently substitute a cloud provider.

Start an optional tool in a normal host terminal and complete its own setup before trying its Scheme session. [The host guide](INSTALL-HOST.md#6-add-an-ai-tool-optional) links to each provider's instructions.

## Find and follow sessions

Open several tabs, name them for the work, and choose the folder a new session will use. The session overview can search the available label, identifier, project folder, opening request, latest request, and last observed action. The amount of useful detail depends on the tool and its local history.

Long tab names can wrap, and the active tab remains within the visible tab strip after it resizes. The project picker includes your home folder and discovers common project locations; [configuration](CONFIGURATION.md#project-folders) explains adding more.

The side panels show supported context, model, task, file activity, Git state, and usage information. These are observations from local files or tools. They may arrive late, be absent, or change when a tool changes its format. **Unknown or not reported does not mean idle, zero usage, or available quota.** Scheme uses literal, redacted, bounded request excerpts and observed actions; it does not call another model to invent a session summary or change your title.

Codex lifecycle reading follows its native rollout records, including large records. Matching a running process to its current conversation uses Linux process information; when that evidence is unavailable, Scheme leaves the attribution unknown. Do not assume exact live Codex attribution on an untested macOS host.

### Approval and sandbox observations

The Telemetry panel labels the last reported approval setting and, for Codex, the sandbox mode separately. An assistant can have approval prompts disabled while still being restricted by a read-only sandbox. Questions can remain pending even when the approval policy says `never`.

These are reported settings, not permission from you. They do not remove filesystem, network, provider, or platform restrictions. Unfamiliar settings are marked unrecognized. On narrow screens, open **Tools** and the telemetry toggle to inspect the panel.

### Themes

Choose **Auto**, **Light**, or **Dark** for the surrounding dashboard. Auto follows the viewing device's preference; a manual choice is saved in that browser when browser storage is available. A blocked storage setting does not stop the dashboard from working. Terminal output keeps a dark background in both themes so ANSI colors remain readable.

## Read and write on a smaller screen

The same dashboard adapts to narrow touch devices; there is no separate Scheme mobile application. Its layout includes a touch key bar for terminal keys and a **Tools** area for additional controls.

On supported narrow touch layouts, **Read** gives you a plain-text snapshot of recent terminal output. It starts with 500 recent lines. **Refresh** gets a new snapshot; **More history** can request up to 8,000 lines. Copy, wrap, and text-size controls help with longer output. This view is a snapshot, so it does not update until you refresh it. A truncation notice means earlier history is outside the retrieved portion.

**Write** gives each session a separate draft area. **Insert only** places text into the terminal for you to inspect; **Send & Enter** also submits it. Scheme checks that the terminal can accept a pasted block and prevents a repeated tap from immediately sending the same in-flight action twice. Saved drafts belong to that browser tab's session storage; treat them as temporary convenience, not a durable backup. Desktop and phone views can keep separate text-size choices.

Focus and Usage are available through the mobile tool controls. Keyboard layout and viewport handling depend on the browser and operating system; responsive emulation does not establish that every physical phone keyboard works identically. Two viewers share the host terminal's underlying layout, so the last focused viewer can affect its dimensions.

## Uploads and browser links

Uploads go into a `.cc-uploads` folder inside the current session's project. Review the destination and file before uploading: it becomes available to commands running with your host account's access. Scheme also relays supported links opened by tools to the viewing browser. These conveniences are not a separate file sync service.

## Continuity: what survives

| Event | What happens | Evidence for this release |
|---|---|---|
| Close the browser completely | The browser detaches; the host terminal can continue. Reopen the page through the same private connection. | A deliberately unfinished Shell job completed while the viewing browser was absent; the same terminal was recovered. |
| Restart the Linux Scheme service | The web process restarts and reconnects to existing tmux sessions. | The web process changed while the terminal process and creation time stayed the same; its running job finished. |
| Restart a foreground Scheme server | Existing tmux sessions normally remain available to reconnect. | This is the intended terminal behavior; the explicit restart evidence above used the supplied Linux service. |
| Sleep the host | Work stops progressing until the host wakes, and the remote connection may drop. | Do not rely on sleep for continuous work. |
| Reboot the host, stop tmux, or lose power | Running processes end. Saved tabs may be recreated; supported AI conversations may reopen if their histories and tools are available. | The Linux service restarted after a real guest reboot and recreated the saved Shell as a **new process**. |

Reopening a tab or conversation is different from recovering a running process. A reboot does not preserve a command in progress, unsaved process state, or a live model response. Cloud conversation recovery depends on the installed CLI, its sign-in, saved history, and project folders; it was not validated with real cloud accounts for this release.

Automatic Codex recovery resumes only a verified interactive CLI conversation. If Scheme cannot establish a safe match, it preserves the tab and history with a recovery-paused notice instead of guessing which conversation to resume. Review that notice and the original tool history before starting another session.

The default idle cleanup considers old sessions, but working and waiting sessions are retained. Unknown activity is not sufficient evidence that an agent is idle. A revived tab retains its original age for cleanup decisions. See [configuration](CONFIGURATION.md#all-settings) for the threshold.

## Validation for v1.1.0

The desktop setup used **two separate graphical Ubuntu 24.04 ARM64 virtual machines**, each with 4 virtual CPUs, 8 GiB of memory, and its own disk. Both ran an XFCE desktop with a real graphical Chromium browser. The host ran Scheme; the viewing desktop reached it through an SSH tunnel. These were hosted desktop machines, not a browser viewport presented as a second operating system.

| Area | What was exercised | Limit |
|---|---|---|
| Host prerequisites | Ubuntu packages, Node.js 22, tmux 3.4, `script`, UTF-8 locale, and Scheme's doctor. | This does not certify every Linux distribution or CPU architecture. |
| Small-host memory | The default reserve blocked an 8 GiB guest; the documented `SYSMON_MEM_FLOOR_MB=1024` allowed the Shell test. | A lower reserve creates no additional memory and is not a workload memory cap. |
| Host and viewing desktop | A real Shell and SSH viewing from the other desktop. | SSH access must already work on your own devices. |
| Continuity | Complete browser exit, Scheme service restart, and actual host reboot. | Browser and service continuity do not imply running jobs survive reboot. |
| UI behavior | Themes, blocked browser storage, session search, and responsive layouts checked in Chromium. | Narrow viewport and touch emulation are not physical phone validation. |
| Optional cloud tools | Installation instructions and local CLI integration. | No real cloud AI sign-in, billed response, or provider-specific recovery was claimed. |
| Local inference | Ollama 0.34.4 with a small downloaded Qwen3 model returned a test response, both directly and through Claude Code 2.1.285 using the local wrapper. | This checked connectivity, not coding quality or the default 30B model. The configured Ollama context and client context both used 32,768 tokens. |
| Tailscale | Official private Serve setup is documented. | A real Tailscale account connection was not completed in the desktop test. |
| Other hosts | macOS and WSL setup alternatives are documented. | Both remain unverified as hosts for this release. |

Screenshots and films use clean demonstration content. Any staged AI conversation is an illustration, not proof that a provider was called. The public website hosts only the presentation and reviewed media; it does not run Scheme or expose a terminal.

## Where to go next

Follow the [host guide](INSTALL-HOST.md) for your first Shell, the [desktop guide](INSTALL-DESKTOP.md) for another computer, or the [phone guide](INSTALL-MOBILE.md) for the private mobile route. If something differs on your system, use [troubleshooting](TROUBLESHOOTING.md) and report the last step that worked.
