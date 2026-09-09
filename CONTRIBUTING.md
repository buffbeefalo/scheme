# Contributing

[Home](README.md) · [Troubleshooting](TROUBLESHOOTING.md) · [Release checks](PUBLISHING.md)

Issues and focused pull requests are welcome. Scheme is maintained here as one standalone application. You do not need access to another repository to run it, fix it, or use it on a phone.

For a bug report, include the failing step and the details listed in [troubleshooting](TROUBLESHOOTING.md#reporting-a-problem). Remove private information from any output you share.

## Development checks

With Node.js 22+ and tmux available, run these from the Scheme folder:

```bash
npm test
npm run check:release
```

The default suite uses Node's test runner. Server tests use disposable state and private tmux sockets; they do not require signed-in AI tools. Tests do not verify every real provider version or every browser. One Codex transcript-fixture case is excluded by the test command because its private rollout data is not shipped. Additional real-session integration cases are opt-in; see [verification coverage](PUBLISHING.md#what-the-checks-do-and-do-not-cover).

Use a UTF-8 locale for terminal integration. Do not run broad integration flags against your live agents or shared sessions. The selected Shell and scroll tests can be exercised with an isolated home and tmux directory without an AI provider; the [release guide](PUBLISHING.md#local-checks) gives that command.

## Keep changes focused

- Preserve the loopback, Host, Origin, and Funnel guards. A terminal grants the host account's permissions.
- Keep new dependencies justified; Scheme currently uses only Node built-ins and its vendored terminal client.
- Use generic sample projects and synthetic test data. Do not copy real agent conversations, credentials, app state, uploads, or personal screenshots into a test fixture.
- If you add or rename a source file, inspect it and update [release-files.json](release-files.json) by hand. A failing release check is a request to review the file, not to automatically approve every file in the tree.
- Check relevant setup and troubleshooting instructions when behavior changes. Keep model/account/version limitations explicit.

macOS and WSL host reports are especially useful because those host paths still need verification. Include the platform and the exact command or interaction tested.
