# Security

[Home](README.md) · [Connection guides](INSTALL-REMOTE.md) · [Release checks](PUBLISHING.md)

## Who can use the dashboard

A Scheme terminal runs as your user on the working computer. Someone who can use that terminal can read and change files and run commands with that account's permissions. The optional AI tools have that access too, subject to their own permission settings.

Scheme has no separate login page. SSH authentication or your private Tailscale network is the access control. Use trusted devices and limit who can reach the service. A loopback proxy is trusted by the application, so a public or broadly shared proxy would undermine that boundary even if Scheme itself still listened locally.

## Connection protections

| Protection | Purpose |
|---|---|
| Default listen address `127.0.0.1` | Keep the server local to the working computer; leave this setting unchanged. |
| Trusted Host checks | Refuse requests served through unexpected names, including DNS-rebinding attempts. |
| Loopback socket checks on terminal routes and WebSocket | Refuse direct network connections to the terminal. SSH tunnels and Tailscale Serve terminate locally. |
| Same-origin checks on state-changing requests and WebSocket | Prevent another browser origin from driving the terminal. |
| Tailscale Funnel detection | Refuse the terminal when public exposure is detected; sustained probe failure also fails closed. |
| Session ID validation, bounded requests, and project file jail | Limit untrusted request values and constrain file-browser/upload routes to the session project. |
| Environment scrubbing and audit records | Avoid inheriting the launching agent's session identity and record privileged actions. |

These guards are not a sandbox for commands typed into a terminal. A shell or AI tool can access anything your host account can access. The project file jail applies to Scheme's file routes, not to arbitrary shell commands.

## Data and transport

SSH encrypts its tunnel. Tailscale Serve supplies HTTPS within the tailnet; Scheme does not supply its own TLS. Do not expose Scheme with a router port forward, public reverse proxy, or Tailscale Funnel.

Uploaded files are saved as sent under the session project's `.cc-uploads` folder and are not scanned. Agent conversations and credentials stay in their normal host-side configuration locations. Choosing a cloud AI tool sends the data you give that tool to its provider under your account's settings; Scheme does not make that cloud use local or private by itself.

The local-model wrapper uses a separate configuration directory and a local Ollama endpoint by default. Tools can still access the network. Use a downloaded local model if you want local inference, and review your own model/tool settings.

## Reporting

For an exploitable security issue, use GitHub's private vulnerability-reporting option if enabled, or contact the repository owner privately before posting a working exploit. Do not put credentials, personal transcripts, or an exposed working dashboard URL in a public issue.

Ordinary setup bugs can go in a public issue with the [safe diagnostic details](TROUBLESHOOTING.md#reporting-a-problem). No scanner or test suite proves that a release contains no sensitive data; the [release checks](PUBLISHING.md) explain the scope and required review.
