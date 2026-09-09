#!/usr/bin/env node
'use strict';

const path = require('node:path');

// Only carry Scheme configuration into the service, not credentials or the installing agent's identity.
const settings = [
  'PATH', 'SHELL', 'SYSMON_PORT', 'SYSMON_HOST', 'SYSMON_MAX_SESSIONS', 'SYSMON_MEM_FLOOR_MB',
  'SYSMON_TMUX_SOCKET', 'SCHEME_PROJECT_DIRS', 'COMMAND_DECK_CLAUDE', 'COMMAND_DECK_CODEX',
  'COMMAND_DECK_CLAUDE_LOCAL', 'COMMAND_DECK_CLAUDE_ARGS', 'COMMAND_DECK_ALLOWED_HOSTS',
  'COMMAND_DECK_IDLE_CLOSE_HOURS', 'COMMAND_DECK_REGISTRY', 'COMMAND_DECK_AUDIT', 'COMMAND_DECK_NOTES',
  'CLAUDE_LOCAL_MODEL', 'CLAUDE_LOCAL_BASE', 'CLAUDE_LOCAL_BIN', 'CLAUDE_LOCAL_CONFIG',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'OLLAMA_HOST',
];

function checked(value, name) {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name} must not contain control characters`);
  return value;
}

function systemdQuote(value, command = false) {
  let escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  if (command) escaped = escaped.replaceAll('$', '$$$$');
  return `"${escaped}"`;
}

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function render(platform, root, env) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22 or newer is required');
  if (!root || !path.isAbsolute(root)) throw new Error('an absolute Scheme directory is required');
  checked(root, 'Scheme directory');
  const values = { SYSMON_PORT: env.SYSMON_PORT || '3000' };
  for (const key of settings) if (env[key] !== undefined) values[key] = checked(env[key], key);
  const launcher = path.join(root, 'bin/scheme');

  if (platform === 'Linux') {
    return `[Unit]
Description=Scheme — remote coding cockpit
After=network-online.target

[Service]
Type=simple
${Object.entries(values).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join('\n')}
ExecStart=/usr/bin/env bash ${systemdQuote(launcher, true)}
# tmux and its sessions deliberately outlive the web server.
KillMode=process
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
  }
  if (platform === 'Darwin') {
    const log = xml(path.join(checked(env.HOME || '', 'HOME'), 'Library/Logs/scheme.log'));
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.scheme.server</string>
  <key>ProgramArguments</key><array><string>/usr/bin/env</string><string>bash</string><string>${xml(launcher)}</string></array>
  <key>EnvironmentVariables</key><dict>
${Object.entries(values).map(([key, value]) => `    <key>${key}</key><string>${xml(value)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
  }
  throw new Error(`unsupported platform ${platform}`);
}

try {
  process.stdout.write(render(process.argv[2], process.argv[3], process.env));
} catch (err) {
  console.error(`scheme service: ${err.message}`);
  process.exitCode = 1;
}
