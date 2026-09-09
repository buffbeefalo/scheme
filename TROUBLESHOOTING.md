# Troubleshooting

[Home](README.md) · [Host setup](INSTALL-HOST.md) · [Desktop connection](INSTALL-DESKTOP.md) · [Phone connection](INSTALL-MOBILE.md)

Start with the last step that worked. A successful Shell test on the working computer tells you Scheme itself is running; a failure only on another device usually points to the connection.

## I cannot find the Scheme folder

A ZIP is a package of files. Extract it first, then open the extracted **scheme-main** folder. You should see `README.md`, `server.js`, and `bin` inside it.

On Ubuntu, right-click empty space inside that folder and choose **Open in Terminal**. Or type `cd ` in Terminal, drag the folder into the window, and press Enter. Run `ls`: if those files are absent, you are in the wrong place.

If the script says **Permission denied**, run this inside the extracted folder, then try again:

```bash
chmod +x bin/scheme bin/scheme-doctor bin/claude-local bin/install-service.sh
```

## The page does not open

**First, on the working computer:** keep the terminal running `bin/scheme` open and try <http://localhost:3000>. If it does not load, read the startup message. Run `bin/scheme-doctor` from a second terminal in the Scheme folder to check the prerequisites.

**On another desktop or phone:** use the full **https://…ts.net** address from Tailscale Serve, with Tailscale connected on both devices. `localhost` on the viewing device only works if an SSH tunnel is open there. Check that the working computer is awake.

A **port already in use** message usually means another Scheme server or application is already using port 3000. If you installed the background service, do not also start the foreground server. Otherwise use `bin/scheme --port 3100`, open <http://localhost:3100> on the host, and update the Tailscale target or SSH tunnel to the same host port.

## Tailscale does not open Scheme

1. Open Tailscale on both devices and check they are connected to the same account/network.
2. Confirm Scheme opens at `http://localhost:3000` **on the working computer**.
3. In a terminal on the working computer, run `tailscale serve status`. Use the exact HTTPS URL it shows.
4. If Serve requested HTTPS setup, finish the link it printed and rerun the command from [host step 5](INSTALL-HOST.md#5-connect-privately-with-tailscale).
5. If another service already owns Tailscale's HTTPS port 443, inspect that setup before changing it. An experienced user can select another HTTPS port and configure Scheme's trusted host list as needed; do not overwrite an application you rely on just to follow the example.

A **lock card** means Scheme refused the terminal connection. Use the documented SSH tunnel or Tailscale Serve route, with Scheme still bound to `127.0.0.1`. Direct LAN addresses are not the intended connection.

**403 untrusted dashboard host:** start with `localhost` on the host or the advertised Tailscale HTTPS name remotely. Custom DNS names require an explicit trusted-host setting; [configuration](CONFIGURATION.md#all-settings) explains it.

**503 public Funnel exposure is blocked:** Scheme detected public Tailscale Funnel exposure or could not verify that the exposure was absent. Inspect the host's Tailscale configuration and [Funnel documentation](https://tailscale.com/docs/reference/tailscale-cli/funnel). Turn off public exposure before retrying; keep Scheme private through Serve. If the probe itself is failing, fix Tailscale rather than disabling the guard.

## A new tab says low memory

Scheme's default reserve is 8,000 MiB of available memory on Linux. This commonly blocks an 8 GB computer. For Shell or cloud tools, follow the [smaller-host example](INSTALL-HOST.md#memory-on-smaller-hosts). Close other workloads or reduce the number of sessions. A local model needs its own extra RAM/VRAM and may need a smaller model; lowering the guard does not create memory.

## An AI tab closes or returns to a command prompt

The optional tool may be missing, unsigned-in, or rejecting an option. On the working computer, run the same tool (`claude` or `codex`) in a normal terminal and read its error. Complete your own sign-in there. Then run `bin/scheme-doctor` in the Scheme folder and try a new tab.

For a Claude error about **--effort**, set a supported effort option or an empty value before starting Scheme. The [Claude effort setting](CONFIGURATION.md#claude-effort-setting) applies to new and resumed cloud sessions.

For **Ollama not reachable**, start Ollama on the working computer and keep the wrapper pointed at its local address. For **model is not pulled**, use `ollama list` to check the exact downloaded name; pull the intended model if your hardware has enough memory and disk. The Local LLM lane also needs the Claude Code program. It does not silently switch to a cloud model when its preflight fails.

Model, context, or account meters may be missing if the installed tool version does not provide the expected local telemetry. A missing meter does not mean the terminal itself is broken or the account has zero usage.

## Tabs are missing or their details look wrong

Check `locale charmap` in the terminal that starts Scheme. It should print **UTF-8**. With tmux 3.4, a server started under a non-UTF-8 locale can turn tab separators in session metadata into underscores, preventing Scheme from recognizing the fields correctly.

On Ubuntu/Debian, use `export LANG=C.UTF-8` and `export LC_ALL=C.UTF-8` before launching Scheme. Other systems may use a different installed UTF-8 locale; `locale -a` lists the choices. A service also needs a UTF-8 locale in its own environment; the Scheme installer does not currently persist locale overrides.

Changing the launcher's locale does not repair an already running tmux server. Save your work before arranging a tmux restart or a host reboot. **Do not run a blanket tmux kill command**: other terminals may use the same server. If you use systemd, an experienced user can set `LANG` and `LC_ALL` in a user-service override; a restart only helps once tmux itself starts with the correct locale.

## After a disconnect or reboot

| What happened | What to expect |
|---|---|
| Browser closed, phone locked, or network dropped | The display disconnects. Sessions may keep running while the working computer stays awake. Reopen the page with the private connection restored. |
| Foreground Scheme server restarted | Existing tmux sessions normally remain and can be reattached. |
| Linux background service restarted | The supplied service leaves tmux sessions running. |
| Working computer went to sleep | Work pauses until it wakes, and the connection drops. |
| Working computer rebooted or tmux was stopped | Running processes are lost. Scheme attempts to recreate saved tabs after it starts again. Shell starts fresh; supported AI conversations may resume from saved identifiers. |

Reopening a conversation is not restoring the running process. Unsaved command state and long-running shell jobs do not survive a reboot. Recovery also depends on your installed tool version, saved conversation identifiers, sign-in, and project folders.

If new tabs also fail after reboot, run `bin/scheme-doctor` and inspect the Scheme logs. Check the reported tmux error before changing socket directories or permissions.

## Foreground works but the background service fails

The saved PATH may point at a moved Node or agent installation. Open the terminal where `bin/scheme` works, export your settings again, and rerun `bin/install-service.sh` from the current Scheme folder.

On Linux, inspect `systemctl --user status scheme` and `journalctl --user -u scheme -n 50`. Confirm no foreground server already owns the same port. Systemd must be available for the Linux service. WSL also needs a running distribution; installing the service alone does not start it from Windows.

## Phone keyboard or scrolling problems

Use an up-to-date browser. Tap inside the terminal to bring back the keyboard. Try landscape orientation for more room, close and reopen the keyboard, or reload the page after reconnecting. These problems can be browser or device specific; the page's resize handling is not a guarantee for every mobile keyboard.

If a Claude session's full-screen renderer has no scrollback, try a fresh Scheme tab. Scheme requests its inline renderer for new sessions. Tool versions and renderer settings can affect this; report the tool and browser versions if the problem remains.

## Reporting a problem

Include the guide step, exact error message, working computer's OS, browser/device, Node and tmux versions, and whether the harmless Shell command worked locally and remotely. `bin/scheme-doctor` can help collect setup information.

Review the output before sharing it: remove usernames, hostnames, addresses, project names, account details, and anything private. Do not upload your agent settings, conversation files, logs, screenshots containing personal work, or `.cc-uploads` folder. Security issues should follow [the private reporting guidance](SECURITY.md#reporting).
