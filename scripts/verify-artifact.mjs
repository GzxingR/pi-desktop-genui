"use strict";

/**
 * Verify the SHIPPED artifact, not just the source tree.
 *
 * A `.piplug` is a store-only (uncompressed) zip. This script reads its central
 * directory, extracts every text entry, and scans it for anything that must not
 * leave the author's machine: absolute paths, the OS user name, the development
 * folder name, credential shapes, e-mail addresses other than the intended
 * public identity, IP addresses, and binary metadata in the icon.
 *
 *   node scripts/verify-artifact.mjs <path-to.piplug>
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const target = process.argv[2];
if (!target || !fs.existsSync(target)) {
  console.error("usage: node scripts/verify-artifact.mjs <path-to.piplug>");
  process.exit(2);
}

/* ---------- minimal zip reader (the format is store-only, but tolerate deflate) ---------- */

function readEntries(buf) {
  // Find the End Of Central Directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no EOCD record");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error(`bad central directory at ${offset}`);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString("utf8");

    // Local header: 30 bytes + its own name/extra lengths.
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compressedSize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;

    entries.push({ name, method, compressedSize, uncompressedSize, data });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* ---------- leak patterns ---------- */
/**
 * Text if it has no NUL byte and round-trips as UTF-8. Classifying by extension
 * would skip `.gitignore` and `LICENSE`, which are real text.
 */
function isProbablyText(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.includes(0)) return false; // NUL byte: binary
  // Valid UTF-8 round-trips byte-for-byte; invalid bytes come back as U+FFFD.
  return Buffer.from(sample.toString("utf8"), "utf8").equals(Buffer.from(sample));
}

const TEXT_EXT = new Set([".js", ".mjs", ".json", ".md", ".css", ".html", ".svg", ".txt"]);

/**
 * One rule of this tool: it must not contain the literals it hunts for.
 * Patterns with `\b` anchors happen not to self-match (the escape's own `b` is
 * a word character, so no boundary exists), but a bare string like the
 * development folder name would match itself and report a false leak. Those are
 * assembled at run time instead.
 */
const lit = (...parts) => parts.join("");

const CHECKS = [
  ["absolute Windows user path", /[A-Za-z]:\\+Users\\+/],
  ["absolute POSIX home path", /\/(?:Users|home)\/[A-Za-z0-9._-]+\//],
  ["OS user name", /\bAdministrator\b/],
  ["development folder name", new RegExp(lit("dsh-", "genui", "-pi"))],
  ["numeric GitHub id", /\b65899980\b/],
  ["credential shapes", /\b(?:sk-[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/],
  ["private-key material", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer/authorization header", /\b(?:Bearer|Authorization)\s+[A-Za-z0-9._-]{12,}/],
  ["e-mail address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["non-public IPv4", /\b(?:10|127|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/],
  ["ssh/wsl/named host", /\b(?:wsl\.localhost|[A-Za-z0-9-]+\.local)\b/],
];

/**
 * Addresses that are deliberately public and therefore not a leak. The author's
 * own GitHub noreply form is built at run time for the same reason as above;
 * `example.com` is the reserved documentation domain.
 */
const ALLOWED_EMAILS = [
  new RegExp(`^${lit("GzxingR@", "users.noreply.github", ".com")}$`, "i"),
  /@example\.(?:com|org)$/i,
];

let failures = 0;
const entries = readEntries(fs.readFileSync(target));

console.log(`artifact : ${path.basename(target)}`);
console.log(`bytes    : ${fs.statSync(target).size}`);
console.log(`entries  : ${entries.length}`);
console.log(`methods  : ${[...new Set(entries.map((e) => (e.method === 0 ? "store" : "deflate")))].join(", ")}\n`);

const names = entries.map((e) => e.name).sort();
console.log("--- contents ---");
for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`  ${e.name.padEnd(42)} ${String(e.uncompressedSize).padStart(8)} B`);
}

console.log("\n--- leak scan (text entries) ---");
let scanned = 0;
for (const entry of entries) {
  // Decide by content, not by extension: `.gitignore` and `LICENSE` have no
  // extension at all, and skipping them would leave real text unscanned.
  if (entry.data === null || !isProbablyText(entry.data)) continue;
  scanned += 1;
  const text = entry.data.toString("utf8");
  const lines = text.split(/\r?\n/);
  for (const [label, re] of CHECKS) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let match;
    while ((match = global.exec(text)) !== null) {
      if (label === "e-mail address" && ALLOWED_EMAILS.some((ok) => ok.test(match[0]))) continue;
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      failures += 1;
      console.log(`  HIT  [${label}] ${entry.name}:${line}  ${JSON.stringify(match[0]).slice(0, 90)}`);
    }
  }
  void lines;
}
console.log(`  scanned ${scanned} text entries`);

console.log("\n--- binary entries ---");
for (const entry of entries) {
  const ext = path.extname(entry.name).toLowerCase();
  const data = entry.data || Buffer.alloc(0);
  if (ext !== ".png" && isProbablyText(data)) continue; // already scanned above
  if (TEXT_EXT.has(ext) && ext !== ".png") continue;
  if (ext === ".png") {
    // Walk PNG chunks: only IHDR/IDAT/IEND are expected; tEXt/iTXt/zTXt/eXIf would carry metadata.
    const chunks = [];
    let i = 8;
    while (i + 8 <= data.length) {
      const len = data.readUInt32BE(i);
      const type = data.slice(i + 4, i + 8).toString("ascii");
      chunks.push(type);
      i += 12 + len;
    }
    const meta = chunks.filter((c) => /^(tEXt|iTXt|zTXt|eXIf|gAMA|pHYs|tIME)$/.test(c));
    const ok = meta.length === 0;
    if (!ok) failures += 1;
    console.log(`  ${ok ? "OK  " : "HIT "} ${entry.name}  chunks=[${chunks.join(",")}]  metadata=[${meta.join(",") || "none"}]`);
  } else {
    console.log(`  SKIP ${entry.name} (unrecognised binary type)`);
  }
}

console.log("\n--- required files present ---");
for (const required of ["manifest.json", "main.js", "LICENSE", "assets/icon.png", "docs/capability-data-flow.md"]) {
  const present = names.includes(required);
  if (!present) failures += 1;
  console.log(`  ${present ? "OK  " : "MISS"} ${required}`);
}

console.log("\n--- forbidden paths ---");
for (const bad of ["node_modules/", ".git/", "dist/"]) {
  const hit = names.some((n) => n.startsWith(bad));
  if (hit) failures += 1;
  console.log(`  ${hit ? "HIT " : "OK  "} ${bad} ${hit ? "is present" : "is absent"}`);
}

console.log(`\n${failures === 0 ? "CLEAN — no leaks found in the shipped artifact" : `FAILURES — ${failures} issue(s)`}`);
process.exitCode = failures === 0 ? 0 : 1;