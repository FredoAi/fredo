/**
 * `@fredo/authoring` — the deterministic packer (Spec #3145, ST-2).
 *
 * `fredo-app pack` emits ORDINARY ZIP BYTES the shipped installer validates: the
 * kit is an authoring-time description, never an enforcement input (NFR-2), so
 * nothing here widens what a package may do.
 *
 * Reproducibility (NFR-3): two runs over the same directory produce byte-equal
 * archives —
 *   - entries are STORED (method 0), so the bytes are a pure function of the
 *     inputs and need no compressor;
 *   - the DOS timestamp is fixed at 1980-01-01T00:00:00 (dosTime 0x0000,
 *     dosDate 0x0021);
 *   - entry order is fixed: `fredo-app.json` first, then `entry.document`, then
 *     `entry.module`, then every remaining file in sorted POSIX-path order —
 *     WHICH IS WHAT MAKES THE VENDORING ROUTE WORK: files an author vendors
 *     into the package (e.g. `vendor/fredo-theme/`) are ordinary entries, so the
 *     recursive walk is what packs them.
 *
 * Node built-ins only.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { MANIFEST_FILENAME, RESERVED_PATH_SEGMENT, listFiles } from './validate.mjs';

const DOS_TIME = 0x0000; // 00:00:00
const DOS_DATE = 0x0021; // 1980-01-01 (the DOS epoch)
const VERSION_NEEDED = 20; // 2.0
const FLAG_UTF8 = 0x0800;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    value = (value >>> 8) ^ CRC_TABLE[(value ^ buffer[index]) & 0xff];
  }
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * The archive's entry order for a package directory.
 *
 * @param {string[]} files every file (POSIX relative), directories excluded
 * @param {{ document: string, module: string }} entry
 * @returns {string[]}
 */
export function orderEntries(files, entry) {
  const ordered = [];
  const push = (name) => {
    if (files.includes(name) && !ordered.includes(name)) ordered.push(name);
  };
  push(MANIFEST_FILENAME);
  push(entry.document);
  push(entry.module);
  const rest = files.filter((file) => !ordered.includes(file)).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return [...ordered, ...rest];
}

/**
 * Validate the names a package would carry (archive-safety, mirrored from the
 * installer's own rules so a package that would be refused is never emitted).
 *
 * @param {string[]} names
 * @returns {{ code: string, field?: string, detail: string } | null}
 */
export function archiveNameViolation(names) {
  for (const name of names) {
    if (name.length === 0 || name.includes('\0')) {
      return { code: 'unsafe_path', field: name, detail: `"${name}" is not a usable archive entry name` };
    }
    if (name.startsWith('/') || name.startsWith('\\') || name.includes(':') || name.includes('\\')) {
      return { code: 'unsafe_path', field: name, detail: `"${name}" is not a relative POSIX path` };
    }
    const segments = name.replace(/\/+$/, '').split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      return { code: 'unsafe_path', field: name, detail: `"${name}" carries an empty, "." or ".." segment` };
    }
    if (segments.includes(RESERVED_PATH_SEGMENT)) {
      return {
        code: 'reserved_path',
        field: name,
        detail: `"${name}" claims the host-reserved "${RESERVED_PATH_SEGMENT}/" segment`,
      };
    }
  }
  return null;
}

/**
 * Build the archive for a package directory.
 *
 * @param {string} directory
 * @param {{ document: string, module: string }} entry the manifest's entry paths
 * @returns {{ archive: Buffer, sha256: string, entries: { name: string, bytes: number }[], names: string[] }}
 */
export function buildArchive(directory, entry) {
  const listing = listFiles(directory);
  const files = listing.filter((name) => !name.endsWith('/'));
  const names = orderEntries(files, entry);

  const violation = archiveNameViolation(names);
  if (violation !== null) {
    throw new ArchiveRefused(violation);
  }

  const parts = [];
  const centralParts = [];
  let offset = 0;

  for (const name of names) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = readFileSync(path.join(directory, name.split('/').join(path.sep)));
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION_NEEDED, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralStart = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  const archive = Buffer.concat([...parts, centralDirectory, eocd]);
  return {
    archive,
    sha256: createHash('sha256').update(archive).digest('hex'),
    entries: names.map((name) => ({
      name,
      bytes: readFileSync(path.join(directory, name.split('/').join(path.sep))).length,
    })),
    names,
  };
}

/** A refusal the packer raises instead of writing a package that would be refused. */
export class ArchiveRefused extends Error {
  constructor(violation) {
    super(`${violation.code}: ${violation.detail}`);
    this.name = 'ArchiveRefused';
    this.violation = violation;
  }
}
