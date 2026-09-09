# Set up your working computer

[Home](README.md) · [Desktop connection](INSTALL-DESKTOP.md) · [Phone connection](INSTALL-MOBILE.md) · [Troubleshooting](TROUBLESHOOTING.md)

The **working computer**, also called the **host**, is where your files and tools live. Run every command in this guide **on that computer**, not on your phone or the separate desktop you will use to view it.

The main steps below are for Ubuntu/Debian Linux, including the Linux path used by DGX Spark. Allow extra time for downloads. You do not need to know Git or install an AI tool to try Scheme.

## 1. Open Terminal and install the basics

On the working computer, open its **Terminal** application. Ubuntu usually opens it with **Ctrl+Alt+T**. If you already use SSH to reach a headless computer, use that existing connection instead.

Paste one command block at a time and press Enter. Wait for the command to finish before continuing. When `sudo` asks for a password, type the working computer's login password; the characters may stay invisible while you type.

**On Ubuntu/Debian or a DGX Spark Linux host:**

```bash
sudo apt-get update
sudo apt-get install -y tmux git curl util-linux unzip
```

These are small system tools. Git helps Scheme show project status and file activity, but no GitHub account or Git knowledge is required. `tmux` keeps terminal sessions alive; `script` supplies the terminal connection and comes with `util-linux`.

Now check for Node.js, the engine Scheme runs on:

```bash
node --version
```

If the result begins with **v22** or a higher number, continue to step 2. If Node is missing or older, this installs Node 22 with the [nvm project's installer](https://github.com/nvm-sh/nvm#installing-and-updating):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 22
node --version
```

Success means the last command prints **v22…**. The installer selects the computer's architecture, so you do not need to choose ARM64 yourself for a Spark. If your organization manages Node, use its supported installation or the [official Node downloads](https://nodejs.org/en/download) instead.

### Other host systems

**macOS:** this host path is not yet verified. With [Homebrew](https://brew.sh) installed, run `brew install node tmux git`. macOS includes `script`. Open the Terminal application and continue with step 2.

**Windows:** native Windows is a viewing device, not a supported Scheme host. Hosting requires a Linux environment inside WSL2; [Microsoft's WSL installation guide](https://learn.microsoft.com/en-us/windows/wsl/install) explains setup. Follow the Ubuntu steps **inside the Ubuntu terminal**, with your projects and AI tools there too. WSL hosting, restart behavior, and remote access are not yet verified for this release.

**Other Linux distributions:** install Node.js 22+, tmux 3.x, `script`, and curl using your distribution's instructions. Linux coverage here does not mean every distribution has been tested.

## 2. Download and open Scheme

**On the working computer, in its browser:**

1. Open the [Scheme project page](https://github.com/buffbeefalo/scheme).
2. Click the green **Code** button, then **Download ZIP**. You can also use the [direct ZIP download](https://github.com/buffbeefalo/scheme/archive/refs/heads/main.zip).
3. Open the downloaded ZIP and choose **Extract** or **Extract All**. This normally creates a folder named **scheme-main**.
4. Move that extracted folder somewhere you will keep it, such as your home folder. Scheme will run from there. Do not try to run it inside the ZIP viewer.
5. Open the **scheme-main** folder in the file manager. On Ubuntu, right-click empty space in the folder and choose **Open in Terminal**. You should see files including `README.md`, `server.js`, and a `bin` folder.

If **Open in Terminal** is unavailable, open Terminal, type `cd ` with a space after it, drag the extracted folder into the terminal window, and press Enter. This changes the terminal's current folder. Alternatively, if you moved it to your home folder, run `cd ~/scheme-main`.

**In that terminal, inside the extracted Scheme folder:**

```bash
chmod +x bin/scheme bin/scheme-doctor bin/claude-local bin/install-service.sh
bin/scheme-doctor
```

The first command makes the launch scripts runnable if your ZIP extractor did not preserve that setting. The doctor checks the tools Scheme needs. Fix required items marked **✘**. Missing Claude, Codex, Ollama, or Tailscale is fine for the first Shell test; those are optional.

If you see **No such file or directory**, you are probably in the wrong folder. See [finding the Scheme folder](TROUBLESHOOTING.md#i-cannot-find-the-scheme-folder).

### UTF-8 locale

In the same terminal, check:

```bash
locale charmap
```

Success is **UTF-8**. If it prints `ANSI_X3.4-1968` or another non-UTF-8 value on Ubuntu/Debian, run `export LANG=C.UTF-8` and `export LC_ALL=C.UTF-8` before starting Scheme. A tmux server started with a non-UTF-8 locale can produce broken tab metadata. [Locale troubleshooting](TROUBLESHOOTING.md#tabs-are-missing-or-their-details-look-wrong) explains existing sessions.

## 3. Start Scheme

**In the Scheme folder on the working computer:**

```bash
bin/scheme
```

Keep this terminal window open. You should see **Scheme — starting on http://127.0.0.1:3000** and a list of the tools it found. A missing optional AI tool does not prevent the Shell test.

**In a browser on that same working computer**, open <http://localhost:3000>. You should see the Scheme dashboard with **Terminal** and **Connect** tabs.

`localhost` means “this computer.” On your phone or a different desktop, that address does not point to the working computer. Set up the private connection in step 5 before using another device.

### Memory on smaller hosts

By default, Scheme refuses a new tab on Linux when less than **8,000 MiB of memory is available**. An 8 GB computer often has less than that available. If your first Shell tab reports **low memory**, stop Scheme with **Ctrl+C** in its original terminal, then start it with a smaller reserve:

```bash
export SYSMON_MEM_FLOOR_MB=1024
bin/scheme
```

This keeps a 1 GiB reserve for a small Shell/cloud-tool setup. It is not a memory cap or a promise that every workload will fit. Local models need additional memory; choose an appropriate reserve and reduce simultaneous sessions. [Memory settings](CONFIGURATION.md#memory-and-session-limits).

## 4. Try a terminal with no AI

**In the Scheme browser page:**

1. Press **＋ New**.
2. Leave the project at your home folder for this first test.
3. Select **Shell**, then press **Start**.
4. Click inside the terminal, type the following, and press Enter:

   ```bash
   echo "Scheme is ready"
   ```

5. You should see **Scheme is ready**. This only prints a message; it does not change your files.

You now have a working browser terminal. Leave this tab open for the connection test on your other device. You can choose a real project folder when you start a later session. Folders in `~/projects`, `~/src`, `~/code`, `~/dev`, `~/repos`, and `~/work` appear automatically; [extra project folders](CONFIGURATION.md#project-folders) are optional.

## 5. Connect privately with Tailscale

This is the recommended route for both a phone and another desktop. Tailscale connects your own devices using a private account network. It requires its own account; check its current plans if you need more than personal use.

**Anyone allowed to reach this dashboard can use the working computer as your user account.** Start with your own trusted devices and do not share that access casually. Scheme does not add a second login screen.

**On the working computer:**

1. Install Tailscale using its [official download and setup guide](https://tailscale.com/download). Sign in to your own account. On Linux the setup uses `sudo tailscale up` and shows a sign-in link.
2. Keep Scheme running. Open **another Terminal window** on the working computer and run:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:3000
   ```

3. If Tailscale asks to enable HTTPS, follow the link it prints, finish that step, and run the command again. If it reports that your user needs permission, repeat the same command with `sudo` in front.
4. Read the **https://…ts.net** address it prints. Save that exact address; it is yours, not the example address from someone else's setup. You can see it again with `tailscale serve status` or in Scheme's **Connect** tab.
5. Follow the [desktop guide](INSTALL-DESKTOP.md) or [phone guide](INSTALL-MOBILE.md) on your viewing device.

This uses [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve), which shares the local service within your private Tailscale network. Keep Scheme at `127.0.0.1`; do not use Funnel or a router port forward. If port 443 already serves another application, do not replace its configuration blindly—see [connection troubleshooting](TROUBLESHOOTING.md#tailscale-does-not-open-scheme).

## 6. Add an AI tool (optional)

Run these installations and sign-ins **on the working computer**, using your own account and choices. Start each tool once in a normal terminal before opening its Scheme tab. You do not need all of them.

### Claude Code

Follow the [official Claude Code setup guide](https://code.claude.com/docs/en/setup). Run `claude` in a normal terminal and complete its sign-in. Cloud use needs your own supported Anthropic account or API setup and may incur charges. Then in Scheme create a new session with **Claude Code**.

If the tool rejects Scheme's default `--effort max` option, choose a supported [effort setting](CONFIGURATION.md#claude-effort-setting) before starting Scheme. That setting applies to new and resumed cloud sessions. Recovery still depends on your installed tool and saved conversation; see [reboot behavior](TROUBLESHOOTING.md#after-a-disconnect-or-reboot).

### Codex

Follow the [official Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli). With Node/npm available, the installation command is:

```bash
npm install -g @openai/codex
codex
```

Complete its sign-in using your own supported account or API setup. Access and usage limits belong to that account. Then create a new Scheme session with **Codex**.

### Local model with Ollama

This is an optional next step after Shell works. A local model uses your computer's memory and processor/GPU. The download can be large, and speed and quality depend on the chosen model and hardware; a Spark does not make every model fit automatically.

1. Install **Claude Code** using the guide above; the Local LLM lane uses its program to talk to Ollama. It does not need an Anthropic cloud sign-in for that local connection.
2. Install [Ollama](https://ollama.com/download) on the working computer and start it. Keep its local endpoint at `http://localhost:11434`.
3. If your machine has enough memory and disk space, download the current Scheme default model:

   ```bash
   ollama pull qwen3-coder:30b
   ```

4. Run `ollama list` and check that the model is present, then run `bin/scheme-doctor` from the Scheme folder.
5. Create a Scheme session with **Local LLM**. [Configuration](CONFIGURATION.md#local-models) explains choosing another downloaded model.

Scheme's wrapper points Claude Code at Ollama, clears inherited Anthropic API-key settings, and stops if the local endpoint or model is unavailable. It uses a separate `~/.claude-local` settings folder. This follows [Ollama's manual Claude Code integration](https://docs.ollama.com/integrations/claude-code). A local endpoint is not an offline guarantee: tools can access the network, and Ollama also offers cloud-backed models. Choose a downloaded local model if local inference is your intent.

## 7. Keep it running at login (optional)

First make sure the foreground setup and a Shell tab work. You can then install a background service so you do not have to leave the launcher terminal open.

**On the working computer**, press **Ctrl+C** in the terminal running Scheme. That stops the web server; tmux sessions remain. From the Scheme folder, with the same exported settings, run:

```bash
bin/install-service.sh
```

The installer saves your current PATH and supported Scheme settings, including explicitly empty values. It does not copy API keys or the identity of the agent session running the installer. Existing agent sign-ins remain in their normal configuration folders.

On Linux it installs a user systemd service and attempts to enable “lingering,” which allows it to run after logout and start on boot. If that requires extra permission, the installer prints the command to run. On macOS the launch agent starts at user login. Inside WSL2, systemd and the WSL distribution must already be running; this does not start Windows or WSL for you.

**Check on Linux:** `systemctl --user status scheme`. Look for **active (running)**, then refresh the Scheme page. To read recent startup errors, use `journalctl --user -u scheme -n 50`. On macOS, logs are under `~/Library/Logs/scheme.log`.

Rerun the installer after moving the Scheme folder, changing a Node version-manager installation, or changing settings. [Configuration](CONFIGURATION.md) lists what it saves.

**Remove only the background service:**

```bash
bin/install-service.sh --remove
```

Removal leaves project files and agent conversations in place. Linux service restarts leave tmux sessions running; close unwanted sessions in Scheme when you want to end them. The working computer must still be powered on and awake.

## Updating

**If you downloaded a ZIP:** stop the Scheme server, download and extract a fresh ZIP into a new folder, and start it from that folder. Keep your own projects outside the Scheme download folder. If you use the background service, rerun its installer from the new folder. Keep the old folder until the update works.

**If you cloned with Git:** run `git pull --ff-only` in your Scheme folder, then restart the foreground server or rerun the background installer. There is no build or `npm install` step for Scheme itself.

## Troubleshooting

Open the [troubleshooting guide](TROUBLESHOOTING.md). Start with the exact step that failed and the message on screen; you do not need to understand the internals to report a useful problem.
