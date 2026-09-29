'use strict';
const { StringDecoder } = require('node:string_decoder');

const MAX_DEPTH = 128;
const MAX_METADATA_CHARS = 1024;
const whitespace = c => c === ' ' || c === '\t' || c === '\r' || c === '\n';
const digit = c => c >= '0' && c <= '9';
const numberEnds = new Set(['zero', 'integer', 'fraction', 'exponentDigits']);
const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

// Validate a whole JSON record without retaining tool output. Only the native
// envelope and optional lifecycle metadata survive; a depth limit is uncertainty,
// not evidence that an earlier start is still the latest boundary.
class LifecycleRecordParser {
  constructor() {
    this.decoder = new StringDecoder('utf8');
    this.stack = [];
    this.rootState = 'value';
    this.fields = { type: null, timestamp: null, payload: null };
    this.token = null;
    this.failure = null;
  }

  write(bytes) {
    if (!this.failure) this.consume(this.decoder.write(bytes));
  }

  fail() { this.failure = 'malformed'; }

  appendString(c) {
    const t = this.token;
    if (!t.capture || t.overflow) return;
    if (t.text.length + c.length > MAX_METADATA_CHARS) { t.text = ''; t.overflow = true; }
    else t.text += c;
  }

  stringCharacter(c) {
    const t = this.token;
    if (t.unicodeLeft) {
      if (!/^[0-9a-fA-F]$/.test(c)) return this.fail();
      t.unicode = t.unicode * 16 + parseInt(c, 16);
      if (--t.unicodeLeft === 0) this.appendString(String.fromCharCode(t.unicode));
    } else if (t.escaped) {
      t.escaped = false;
      if (c === 'u') { t.unicodeLeft = 4; t.unicode = 0; }
      else if (Object.hasOwn(escapes, c)) this.appendString(escapes[c]);
      else this.fail();
    } else if (c === '\\') t.escaped = true;
    else if (c === '"') {
      const value = t.capture && !t.overflow ? t.text : null;
      if (t.key) {
        const frame = this.stack[this.stack.length - 1];
        frame.key = value; frame.state = 'colon';
      } else if (t.target) t.target.object[t.target.key] = value;
      this.token = null;
    } else if (c.charCodeAt(0) < 32) this.fail();
    else this.appendString(c);
  }

  numberCharacter(c) {
    const t = this.token;
    switch (t.state) {
      case 'minus':
        if (c === '0') { t.state = 'zero'; return true; }
        if (digit(c)) { t.state = 'integer'; return true; }
        break;
      case 'zero':
      case 'integer':
        if (t.state === 'integer' && digit(c)) return true;
        if (c === '.') { t.state = 'dot'; return true; }
        if (c === 'e' || c === 'E') { t.state = 'exponent'; return true; }
        break;
      case 'dot':
      case 'fraction':
        if (digit(c)) { t.state = 'fraction'; return true; }
        if (t.state === 'fraction' && (c === 'e' || c === 'E')) { t.state = 'exponent'; return true; }
        break;
      case 'exponent':
        if (c === '+' || c === '-') { t.state = 'exponentSign'; return true; }
        if (digit(c)) { t.state = 'exponentDigits'; return true; }
        break;
      case 'exponentSign':
      case 'exponentDigits':
        if (digit(c)) { t.state = 'exponentDigits'; return true; }
        break;
    }
    if (!numberEnds.has(t.state)) this.fail();
    this.token = null;
    return false;
  }

  beginValue(c, parent) {
    let target = null;
    if (parent?.scope === 'root' && ['type', 'timestamp', 'payload'].includes(parent.key)) {
      target = { object: this.fields, key: parent.key };
    } else if (parent?.scope === 'payload' && ['type', 'turn_id'].includes(parent.key)) {
      target = { object: this.fields.payload, key: parent.key };
    }
    // Clear on every value, including containers: JSON's last duplicate member wins.
    if (target) target.object[target.key] = null;
    if (parent) { parent.state = 'commaOrEnd'; parent.key = null; }
    else this.rootState = 'done';

    if (c === '{' || c === '[') {
      if (this.stack.length >= MAX_DEPTH) { this.failure = 'unknown'; return; }
      let scope = 'other';
      if (c === '{' && !parent) scope = 'root';
      else if (c === '{' && target?.object === this.fields && target.key === 'payload') {
        scope = 'payload'; this.fields.payload = { type: null, turn_id: null };
      }
      this.stack.push({ kind: c, scope, state: c === '{' ? 'keyOrEnd' : 'valueOrEnd', key: null });
    } else if (c === '"') {
      this.token = { kind: 'string', target, capture: !!target, text: '' };
    } else if (c === '-' || digit(c)) {
      this.token = { kind: 'number', state: c === '-' ? 'minus' : c === '0' ? 'zero' : 'integer' };
    } else if (c === 't' || c === 'f' || c === 'n') {
      this.token = { kind: 'literal', word: c === 't' ? 'true' : c === 'f' ? 'false' : 'null', index: 1 };
    } else this.fail();
  }

  consume(text) {
    for (let i = 0; i < text.length && !this.failure; i++) {
      const c = text[i], t = this.token;
      if (t?.kind === 'string') { this.stringCharacter(c); continue; }
      if (t?.kind === 'literal') {
        if (c !== t.word[t.index++]) this.fail();
        else if (t.index === t.word.length) this.token = null;
        continue;
      }
      if (t?.kind === 'number' && this.numberCharacter(c)) continue;
      if (this.failure) break;
      if (whitespace(c)) continue;
      const parent = this.stack[this.stack.length - 1];
      if (!parent) {
        if (this.rootState === 'value') this.beginValue(c, null);
        else this.fail();
      } else if (parent.state === 'keyOrEnd' || parent.state === 'key') {
        if (c === '}' && parent.state === 'keyOrEnd') this.stack.pop();
        else if (c === '"') this.token = { kind: 'string', key: true, capture: parent.scope !== 'other', text: '' };
        else this.fail();
      } else if (parent.state === 'colon') {
        if (c === ':') parent.state = 'value'; else this.fail();
      } else if (parent.state === 'value' || parent.state === 'valueOrEnd') {
        if (c === ']' && parent.state === 'valueOrEnd') this.stack.pop();
        else this.beginValue(c, parent);
      } else if (parent.state === 'commaOrEnd') {
        if (c === (parent.kind === '{' ? '}' : ']')) this.stack.pop();
        else if (c === ',') parent.state = parent.kind === '{' ? 'key' : 'value';
        else this.fail();
      }
    }
  }

  finish() {
    if (!this.failure) this.consume(this.decoder.end());
    if (this.token?.kind === 'number' && numberEnds.has(this.token.state)) this.token = null;
    if (this.failure) return { kind: this.failure };
    if (this.token || this.stack.length || this.rootState !== 'done') return { kind: 'malformed' };
    const { type, timestamp, payload } = this.fields;
    if (type !== 'event_msg' || !payload || !['task_started', 'task_complete', 'turn_aborted'].includes(payload.type)) {
      return { kind: 'unrelated' };
    }
    return { kind: 'event', event: {
      working: payload.type === 'task_started',
      lastTurnId: payload.type === 'task_complete' && payload.turn_id ? payload.turn_id : null,
      observedAt: timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null,
    } };
  }
}

module.exports = { LifecycleRecordParser, MAX_DEPTH, MAX_METADATA_CHARS };
