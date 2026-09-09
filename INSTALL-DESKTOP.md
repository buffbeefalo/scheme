# Open Scheme on a desktop or laptop

[Home](README.md) · [Working computer setup](INSTALL-HOST.md) · [Phone guide](INSTALL-MOBILE.md) · [Troubleshooting](TROUBLESHOOTING.md)

This guide is for a **viewing computer**: a second Windows, Mac, or Linux desktop/laptop. Your projects and tools continue to run on the working computer. You do not install Scheme, Node.js, Claude Code, Codex, or Ollama on the viewing computer.

If this is just a second monitor connected to the working computer, open <http://localhost:3000> on that computer and move the browser to that monitor. No remote setup is needed.

## Recommended connection with Tailscale

Before starting, finish [working computer setup through step 5](INSTALL-HOST.md#5-connect-privately-with-tailscale). Leave Scheme running and keep the working computer awake. Have the **https://…ts.net** address printed by that step ready.

**On the viewing desktop or laptop:**

1. Download and install [Tailscale](https://tailscale.com/download) for this computer.
2. Open Tailscale, sign in to the **same account** you used on the working computer, and make sure it says it is connected.
3. Open your browser. Paste **your working computer's full HTTPS address** into the address bar and press Enter. Do not paste it into the browser's search box, and do not use `localhost` here.
4. You should see Scheme's **Terminal** and **Connect** tabs. Open the Shell tab you created during setup.
5. Click in its terminal, type `echo "Connected from my desktop"`, and press Enter. You should see **Connected from my desktop**.
6. Bookmark the page and place the browser on the screen where you want the dashboard.

You can now make new sessions in the same way as on the working computer. Closing this browser window disconnects the display; it does not close the session. Keep Tailscale connected whenever you return to the page.

Anyone granted access to Scheme through your private network can use the working computer as your account. Use your own trusted devices. See [Security](SECURITY.md).

## Alternative connection with SSH

Use this if you already know how to log in to the working computer with SSH and prefer a tunnel. The working computer needs an SSH server; the viewing computer needs an SSH client. This works wherever your existing SSH connection works.

**On the viewing computer**, open Terminal (Mac/Linux) or PowerShell (Windows). Replace `you@host` with the username and host address you already use for SSH:

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:3000:127.0.0.1:3000 you@host
```

Complete SSH's normal authentication. A connected tunnel often shows **no output**; keep that terminal window open. Now open <http://localhost:3000> in the viewing computer's browser. In this setup the tunnel carries that local address to the working computer.

If port 3000 is already used on the viewing computer, change only the first port:

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:3100:127.0.0.1:3000 you@host
```

Then open <http://localhost:3100>. If Scheme uses a different host port, change the last port to match it too.

On Windows, Scheme's **Connect** tab also offers a downloadable one-click connector after you have reached the dashboard through a working connection. It still needs your own functioning SSH setup. The explicit tunnel command above is easier to diagnose if the connector has trouble.

## If the page does not open

Check [connection troubleshooting](TROUBLESHOOTING.md#the-page-does-not-open). The most common mix-ups are using `localhost` without an SSH tunnel, closing the tunnel window, signing into different Tailscale accounts, or letting the working computer sleep.
