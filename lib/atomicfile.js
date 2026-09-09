'use strict';

const fs = require('node:fs');
const path = require('node:path');

let sequence = 0;

// Write beside the destination and atomically rename into place. A failed write
// or rename leaves the previous durable value untouched and removes the temp.
async function atomicWriteFile(file, data, fsp = fs.promises) {
  const tmp = `${file}.${process.pid}.${++sequence}.tmp`;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
    return true;
  } catch (error) {
    try { await fsp.unlink(tmp); } catch {}
    error.atomicTemp = tmp;
    throw error;
  }
}

module.exports = { atomicWriteFile };
