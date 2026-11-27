#!/usr/bin/env node
'use strict';
// Usage: node tools/inspect-cli.js photo.jpg [--json]
// Prints the metadata analysis (no pixel decoding, so no thumbnail comparison).
const fs = require('fs');
const QPI = require('./load.js');
const file = process.argv[2];
if (!file) { console.error('usage: inspect-cli.js <file.jpg> [--json]'); process.exit(2); }
const buf = fs.readFileSync(file);
const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
const rep = QPI.analyze.inspect(u8, { fileName: file, lastModified: fs.statSync(file).mtimeMs });
if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify(QPI.analyze.toJSON(rep), null, 2)); process.exit(0); }
console.log(`${file}  ${rep.file.size} bytes  sha256 ${rep.file.sha256}`);
rep.findings.forEach(f => console.log(`[${f.severity.toUpperCase().padEnd(4)}] ${f.category.padEnd(11)} ${f.title}`));
