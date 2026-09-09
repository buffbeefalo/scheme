# Connect another device

[Home](README.md) · [Working computer setup](INSTALL-HOST.md)

Scheme runs on your working computer. The other device only needs a browser and a private connection. Start with **Tailscale** for both desktop and phone; it gives you one HTTPS address to bookmark.

| Device | Step-by-step guide |
|---|---|
| Another Windows, Mac, or Linux computer | [Desktop and laptop setup](INSTALL-DESKTOP.md) |
| iPhone, iPad, or Android | [Phone and tablet setup](INSTALL-MOBILE.md) |
| A second monitor on the same computer | Open <http://localhost:3000> on the working computer and move the browser to that monitor. |

## A. Same network — SSH tunnel

Already comfortable with SSH? The [desktop SSH alternative](INSTALL-DESKTOP.md#alternative-connection-with-ssh) includes explicit local binding and a connection check.

## B. Anywhere — Tailscale

Set up Tailscale **on the working computer first** using [host step 5](INSTALL-HOST.md#5-connect-privately-with-tailscale). Then follow the desktop or phone guide above on the viewing device.

## C. Things not to do

Keep Scheme at `127.0.0.1`. Do not use a router port forward, a public proxy, or Tailscale Funnel. Access to the dashboard is access to a terminal as your host account. [Security details](SECURITY.md).

## D. Troubleshooting

Use the [troubleshooting guide](TROUBLESHOOTING.md) for connection, setup, memory, keyboard, and restart problems.
