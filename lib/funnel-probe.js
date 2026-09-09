'use strict';

const { execFile } = require('child_process');

function readServeConfig() {
  return new Promise((resolve) => {
    try {
      execFile('tailscale', ['serve', 'status', '--json'], { timeout: 3000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        resolve({ ok: !err, stdout: String(stdout || '') });
      });
    } catch {
      resolve({ ok: false, stdout: '' });
    }
  });
}

module.exports = { readServeConfig };
