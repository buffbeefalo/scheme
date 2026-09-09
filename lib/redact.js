'use strict';

const REDACTED = '[REDACTED]';

const SECRET_KEYS = [
  'access_token',
  'api_key',
  'apikey',
  'auth_token',
  'client_secret',
  'cookie',
  'discord_token',
  'github_token',
  'gitlab_token',
  'openai_api_key',
  'password',
  'passwd',
  'pwd',
  'refresh_token',
  'secret',
  'secret_key',
  'session_token',
  'slack_token',
  'token',
];

const SECRET_KEY_RE = SECRET_KEYS
  .map((k) => k.replace(/_/g, '[_-]?'))
  .join('|');

function redactSensitiveText(value) {
  if (value == null) return '';
  let out = String(value);
  if (!out) return out;

  out = out.replace(
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    '-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----',
  );

  out = out.replace(
    /\b((?:authorization|proxy-authorization)\s*[:=]\s*)(bearer|basic)\s+([^\s"',;]+)/gi,
    (_m, prefix, scheme) => `${prefix}${scheme} ${REDACTED}`,
  );

  out = out.replace(/\b(bearer)\s+([A-Za-z0-9._~+/=-]{16,})/gi, (_m, scheme) => `${scheme} ${REDACTED}`);

  out = out.replace(
    new RegExp(`((?:"|')?(?:${SECRET_KEY_RE})(?:"|')?\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^"',\\s;}]+)`, 'gi'),
    (match, prefix) => {
      const value = match.slice(prefix.length);
      const quote = value[0] === '"' || value[0] === '\'' ? value[0] : '';
      return quote ? `${prefix}${quote}${REDACTED}${quote}` : `${prefix}${REDACTED}`;
    },
  );

  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, '$1[REDACTED]@');
  out = out.replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_ACCESS_KEY]');
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]');
  out = out.replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_GITLAB_TOKEN]');
  out = out.replace(/(?<![\w-])mfa\.[A-Za-z0-9_-]{20,}(?![\w-])/g, '[REDACTED_DISCORD_TOKEN]');
  out = out.replace(/(?<![\w-])[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{25,}(?![\w-])/g, '[REDACTED_DISCORD_TOKEN]');
  out = out.replace(/(?<![\w-])sk-[A-Za-z0-9_-]{18,}(?![\w-])/g, '[REDACTED_OPENAI_KEY]');
  out = out.replace(/(?<![\w-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![\w-])/g, '[REDACTED_JWT]');
  out = out.replace(/(?<![\w+/=-])[A-Za-z0-9+/_=-]{48,}(?![\w+/=-])/g, (m) =>
    (/^[0-9a-fA-F]+$/.test(m) || !/\d/.test(m) || !/[A-Za-z]/.test(m)
      || /^sha(?:256|384|512)-/.test(m) ? m : '[REDACTED_HIGH_ENTROPY]'));

  return out;
}

module.exports = { redactSensitiveText };
