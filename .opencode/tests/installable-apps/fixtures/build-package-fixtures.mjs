#!/usr/bin/env node
/**
 * build-package-fixtures.mjs -- install-validation packages for Spec #3147 (ST-2),
 * repaired for Spec #3145 (ST-2, drift correction D1).
 *
 * Emits the install-validation packages the QA suite drives the refusal matrix
 * with:
 *
 *   qa3147-valid                 -- installs cleanly (the happy path, AC-1/R-1.1)
 *   qa3147-no-manifest           -- a valid zip with no fredo-app.json  => no_manifest
 *   qa3147-bad-manifest          -- a manifest with an unknown top-level key
 *                                   ("sandbox")                         => manifest_unknown_field
 *   qa3147-zip-slip              -- an entry that escapes the app root   => unsafe_path
 *   qa3147-hash-tamper           -- structurally valid; its bytes are mutated AFTER
 *                                   install to drive                    => integrity_mismatch
 *   qa3147-incompatible-engines  -- a well-formed range excluding this host
 *                                                                       => host_incompatible
 *   qa3147-reserved-path         -- an entry claiming the host-reserved
 *                                   "__fredo/" segment                  => reserved_path
 *   qa3145-missing-field         -- a manifest whose required displayName is ABSENT
 *                                                                       => manifest_invalid_field
 *
 * DRIFT CORRECTION D1 (Spec #3145 ST-2). This generator used to drive
 * `manifest_unknown_field` with the top-level key **`capabilities`** — which
 * #3146 made the manifest's 8th LEGAL key. The same bytes now classify as
 * `manifest_invalid_field` ("capabilities must be an object"), so a row bound to
 * the old expectation would have scored the product's correct behaviour as a
 * defect. The unknown key is now a genuinely-undefined one (`sandbox`), the
 * allowed-key set is read from the PUBLISHED SCHEMA (never a hand-written list,
 * which is how the drift happened), and the generator's own manifest validation
 * is the published schema's rather than a third hand-written copy.
 *
 * DETERMINISM CONTRACT (the same discipline as ST-7's behaviour generator)
 *   - Node built-ins only (node:fs, node:path, node:crypto, node:url) plus the
 *     kit's schema validator (a pure module; it changes VALIDATION, never the
 *     archive bytes). No network, no npm package, no toolchain, no shell-out.
 *   - Zip entries are written in a fixed order with the fixed DOS timestamp
 *     1980-01-01 00:00:00 (dosTime 0x0000, dosDate 0x0021) and method 0
 *     (stored), so two runs produce byte-identical archives. The script prints
 *     each archive's sha256; run it twice and compare.
 *   - Nothing is built from the clock or from randomness: the one value that
 *     looks dynamic (the incompatible package's engine range) is derived from a
 *     FIXED constant, not from the running host version, so the bytes do not
 *     change when Fredo's version does.
 *
 * WHY THE HOST VERSION IS NOT READ HERE
 *   The plan fixes the running version's SOURCE as the crate version
 *   (`env!("CARGO_PKG_VERSION")` in `applications/installed_apps/mod.rs`). A
 *   generator that read `package.json`/`Cargo.toml` to compute "the version plus
 *   one" would silently change its bytes on a version bump and break the
 *   committed sha256s. So the incompatible package pins a range far beyond any
 *   plausible Fredo (`>=999.0.0`): well-formed, and excludes every real build.
 *
 * SCOPE: this script never touches product code. It writes only under the output
 * directory (default .opencode/tmp/3147/fixtures/packages, gitignored) and, with
 * --write-expected, the committed expected-output manifest beside it.
 *
 * Usage:
 *   node .opencode/tests/installable-apps/fixtures/build-package-fixtures.mjs
 *   node ... --out <dir>            override the output directory
 *   node ... --verify               exit 1 unless the committed expected
 *                                   manifest matches the bytes just produced,
 *                                   AND every manifest classifies with the
 *                                   published schema as its recorded code
 *   node ... --write-expected       (re)write package-fixtures.expected.json
 *   node ... --help
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  topLevelKeys,
  validateManifest as validateManifestAgainstSchema,
} from '../../../../packages/fredo-authoring/lib/validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const EXPECTED_PATH = path.join(HERE, 'package-fixtures.expected.json');
const DEFAULT_OUT = path.join(REPO_ROOT, '.opencode', 'tmp', '3147', 'fixtures', 'packages');

/* ==========================================================================
 * Manifest schema -- fixed by the plan. Consumed here, never invented.
 * ========================================================================== */

/* ==========================================================================
 * Manifest validation -- the PUBLISHED SCHEMA, never a hand-written copy.
 *
 * Spec #3145 ST-2 removed this file's third hand-written copy of the schema.
 * The allowed key sets, length caps, patterns and the reserved-id list come from
 * `packages/fredo-authoring/schema/fredo-app.schema.json`, which is generated
 * from the Rust parser's own constants, so a key the parser accepts can never be
 * refused here again (the D1 drift class).
 * ========================================================================== */

/** The frozen 22 refusal codes (the Rust enum mirrors this exactly). */
const REFUSAL_CODES = [
  'not_a_zip',
  'no_manifest',
  'manifest_malformed',
  'manifest_unknown_field',
  'manifest_invalid_field',
  'unsupported_manifest_version',
  'id_invalid',
  'id_reserved',
  'version_invalid',
  'engines_range_invalid',
  'host_incompatible',
  'entry_missing',
  'entry_invalid',
  'unsafe_path',
  'reserved_path',
  'archive_too_large',
  'already_installed',
  'io_error',
  'integrity_mismatch',
  'integrity_record_corrupt',
  'id_not_installed',
  'id_is_installed_app',
];

/** The host-reserved path segment (`RESERVED_PATH_SEGMENT` in Rust). */
const RESERVED_SEGMENT = '__fredo';

/**
 * Validate a manifest with the published schema; returns the FIRST violation or
 * null.
 *
 * The kit performs the semver-RANGE shape check; it is not asked to decide host
 * compatibility here (the fixture set is host-independent by design — see the
 * incompatible-engines rationale in the header), which is why no `--fredo`
 * version is supplied.
 */
function firstManifestViolation(manifest) {
  return validateManifestAgainstSchema(manifest, {})[0] ?? null;
}

/**
 * The plan's archive-safety rules, re-implemented here ONLY to self-check what
 * this script emits. The Rust installer owns the real decision
 * (`applications/installed_apps/archive.rs`); this copy exists so a fixture that
 * is supposed to be unsafe is proven unsafe, and one that must be safe is proven
 * safe, at generation time rather than at test time.
 *
 * Returns null for a safe name, or the name of the refusal it would trigger.
 */
function entryNameRefusal(name) {
  if (name.length === 0 || name.includes('\0')) return 'unsafe_path';
  if (name.startsWith('/') || name.startsWith('\\')) return 'unsafe_path';
  if (name.includes(':') || name.includes('\\')) return 'unsafe_path';

  const trimmed = name.replace(/\/+$/, '');
  if (trimmed.length === 0) return 'unsafe_path';

  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return 'unsafe_path';
  }
  if (trimmed.split('/').includes(RESERVED_SEGMENT)) return 'reserved_path';
  return null;
}

/* ==========================================================================
 * Document + module bodies.
 *
 * These packages exist to exercise INSTALL validation, not runtime behaviour
 * (ST-7 owns that), so the document is a minimal inert page and the module is a
 * minimal ESM `mount`. The host's scheme handler owns the real shell; nothing
 * here duplicates a host `installed-app-*` testid.
 * ========================================================================== */

function documentHtml(displayName) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${String(displayName).replace(/&/g, '&amp;').replace(/</g, '&lt;')} - Fredo install fixture</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <!-- Generated by .opencode/tests/installable-apps/fixtures/build-package-fixtures.mjs
       (Spec #3147, ST-2). This package exercises INSTALL validation only: the
       host scheme handler injects the bootstrap, the theme and the root element,
       then imports entry.module and calls its exported mount(ctx). This file
       deliberately ships no script and claims no host testid. -->
  <noscript>This fixture needs JavaScript.</noscript>
</body>
</html>
`;
}

function moduleJs(id) {
  return `// Generated by .opencode/tests/installable-apps/fixtures/build-package-fixtures.mjs
// (Spec #3147, ST-2). Plain ESM with no bundler and no bundled Tauri API. The
// host imports this file and calls mount(ctx); this fixture draws only inside
// ctx.root and claims no host-owned testid.

export function mount(ctx) {
  var root = ctx && ctx.root;
  if (!root) {
    throw new TypeError('${id}: ctx.root is missing from InstalledAppContext');
  }
  root.setAttribute('data-fixture', '${id}');
  var panel = (root.ownerDocument || document).createElement('section');
  panel.setAttribute('data-package-fixture-panel', '');
  panel.textContent = '${id} mounted (Spec #3147 ST-2 install fixture).';
  root.appendChild(panel);
}
`;
}

/* ==========================================================================
 * Deterministic zip writer -- identical discipline to ST-7's generator.
 *
 *   - method 0 (stored): no deflate stream, so the bytes are a pure function of
 *     the inputs and need no compressor library.
 *   - fixed DOS timestamp 1980-01-01 00:00:00 (dosTime 0x0000, dosDate 0x0021).
 *   - entries emitted in the fixed order the caller passes them.
 * ========================================================================== */

const DOS_TIME = 0x0000; // 00:00:00
const DOS_DATE = 0x0021; // 1980-01-01 (DOS epoch)
const VERSION_NEEDED = 20; // 2.0
const FLAG_UTF8 = 0x0800;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {{name: string, data: Buffer}[]} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const parts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
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
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    parts.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(VERSION_NEEDED, 4);
    cd.writeUInt16LE(VERSION_NEEDED, 6);
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);

    centralParts.push(cd, name);
    offset += local.length + name.length + data.length;
  }

  const centralStart = offset;
  const centralDirectory = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralDirectory, eocd]);
}

/**
 * Read an archive back from its own bytes and verify every entry's CRC + names.
 * Deliberately a DIFFERENT code path from the writer (it walks the central
 * directory and each local header), so a corruption mirrored into both structures
 * would still surface.
 */
function verifyZip(buf) {
  if (buf.length < 22) throw new Error('archive too short to hold an EOCD');
  const eocdOffset = buf.length - 22;
  if (buf.readUInt32LE(eocdOffset) !== 0x06054b50) throw new Error('EOCD signature missing');

  const count = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (cdOffset + cdSize > buf.length) throw new Error('central directory out of bounds');

  const entries = [];
  let cursor = cdOffset;

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('bad central header at offset ' + cursor);
    }
    const method = buf.readUInt16LE(cursor + 10);
    const crc = buf.readUInt32LE(cursor + 16);
    const compressed = buf.readUInt32LE(cursor + 20);
    const uncompressed = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.slice(cursor + 46, cursor + 46 + nameLen).toString('utf8');

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('bad local header for ' + name);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.slice(dataStart, dataStart + compressed);

    if (method !== 0) throw new Error('unexpected compression method ' + method + ' for ' + name);
    if (data.length !== uncompressed) throw new Error('size mismatch for ' + name);
    if (crc32(data) !== crc) throw new Error('crc mismatch for ' + name);

    entries.push({ name, bytes: uncompressed, crc32: crc.toString(16).padStart(8, '0') });
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/** Locate one entry's payload by name. */
function readZipEntry(buf, wantedName) {
  const eocdOffset = buf.length - 22;
  const count = buf.readUInt16LE(eocdOffset + 10);
  let cursor = buf.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < count; i++) {
    const compressed = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.slice(cursor + 46, cursor + 46 + nameLen).toString('utf8');

    if (name === wantedName) {
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      return buf.slice(start, start + compressed);
    }
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return null;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/* ==========================================================================
 * The fixture catalog -- the single source of truth for the packages AND for
 * the committed expected-output manifest.
 *
 * `expects` is the refusal code the package must drive, or null for the package
 * that installs cleanly. `defect` documents WHERE the defect lives, because the
 * QA row T-3.2 must read which manifest shape a fixture actually exercises.
 * ========================================================================== */

/** The extra entry names that make a package unsafe on purpose. */
const ZIP_SLIP_ENTRY = '../../qa3147-escaped.txt';
const RESERVED_ENTRY = '__fredo/bootstrap.js';

/** The far-future range: well-formed, and excludes every real Fredo build. */
const INCOMPATIBLE_RANGE = '>=999.0.0';

/**
 * The byte the hash-tamper tester mutates AFTER install, and where.
 *
 * `main.js` opens with a fixed comment block, so offset `TAMPER_OFFSET` lands
 * inside inert text: flipping it cannot change module semantics, only the hash.
 * The original byte is recorded so the tester can restore the file and prove the
 * block clears on the next activation attempt (T-4.4).
 */
const TAMPER_FILE = 'main.js';
const TAMPER_OFFSET = 3;

const FIXTURES = [
  {
    id: 'qa3147-valid',
    displayName: 'QA3147 Valid',
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    description:
      'ST-2 happy path: a valid package that installs cleanly (AC-1 / R-1.1).',
    expects: null,
    defect: null,
    extraEntries: [],
    tamper: null,
  },
  {
    id: 'qa3147-no-manifest',
    displayName: 'QA3147 No Manifest',
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    description: 'ST-2 refusal fixture: a valid zip with no fredo-app.json at its root.',
    expects: 'no_manifest',
    defect: 'no fredo-app.json entry (the zip is otherwise well-formed)',
    omitManifest: true,
    extraEntries: [],
    tamper: null,
  },
  {
    id: 'qa3147-bad-manifest',
    displayName: 'QA3147 Bad Manifest',
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    description:
      'ST-2 refusal fixture: a manifest carrying an unknown top-level key (manifestVersion 1 is a closed schema).',
    // CHOICE RECORDED (T-3.2 asks which shape): an UNKNOWN TOP-LEVEL KEY.
    // The three manifest shapes drive three DIFFERENT codes, so the committed
    // manifest must say which one this fixture exercises:
    //   unparseable JSON        -> manifest_malformed
    //   unknown top-level field -> manifest_unknown_field   <-- this fixture
    //   non-1 manifestVersion   -> unsupported_manifest_version
    //
    // DRIFT CORRECTION D1 (Spec #3145): this key used to be `capabilities`,
    // which #3146 made the manifest's 8th LEGAL key. `sandbox` is genuinely
    // undefined at every manifestVersion this build reads.
    expects: 'manifest_unknown_field',
    defect: 'unknown top-level key "sandbox" (manifestVersion 1 does not define it)',
    unknownField: 'sandbox',
    extraEntries: [],
    tamper: null,
  },
  {
    id: 'qa3147-zip-slip',
    displayName: 'QA3147 Zip Slip',
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    description:
      'ST-2 refusal fixture: an archive entry whose path escapes the app root (zip-slip).',
    expects: 'unsafe_path',
    defect: 'archive entry "../../qa3147-escaped.txt" carries a ".." component',
    // The SHAPE recorded for T-3.4: a parent-directory traversal (the other
    // members of the family are an absolute path, a drive/UNC prefix and a
    // symlink entry).
    unsafeShape: 'parent-directory traversal ("..")',
    extraEntries: [{ name: ZIP_SLIP_ENTRY, data: 'escaped!\n' }],
    tamper: null,
  },
  {
    id: 'qa3147-hash-tamper',
    displayName: 'QA3147 Hash Tamper',
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    description:
      'ST-2 integrity fixture: installs cleanly, then a post-install byte mutation must be detected.',
    // NOTE: this package INSTALLS. Its expected code is reached at LOAD time
    // (ST-3's verify-at-serve), so `expectedStage` below records `load` and the
    // committed manifest carries it. A tester must mutate the installed byte
    // first; an install-time refusal here would itself be the defect.
    expects: 'integrity_mismatch',
    defect: 'none at install time; the tester mutates one installed byte',
    extraEntries: [],
    tamper: { file: TAMPER_FILE, offset: TAMPER_OFFSET },
  },
  {
    id: 'qa3147-incompatible-engines',
    displayName: 'QA3147 Incompatible Engines',
    version: '1.0.0',
    enginesFredo: INCOMPATIBLE_RANGE,
    description:
      'ST-2 refusal fixture: a well-formed engines.fredo range that excludes the running Fredo.',
    expects: 'host_incompatible',
    defect: 'engines.fredo ">=999.0.0" is well-formed but excludes every real build',
    extraEntries: [],
    tamper: null,
  },
  {
    id: 'qa3147-reserved-path',
    displayName: 'QA3147 Reserved Path',
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    description:
      'ST-2 refusal fixture: an archive entry claiming the host-reserved "__fredo/" path segment.',
    expects: 'reserved_path',
    defect: 'archive entry "__fredo/bootstrap.js" claims the host-reserved segment',
    extraEntries: [{ name: RESERVED_ENTRY, data: '// host-owned bootstrap\n' }],
    tamper: null,
  },
  {
    // Spec #3145 ST-2 (AC5's required-field leg; QA's F-8.21(c) reads it).
    id: 'qa3145-missing-field',
    displayName: 'QA3145 Missing Field',
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    description:
      'ST-2 refusal fixture: a manifest that OMITS the required displayName field.',
    expects: 'manifest_invalid_field',
    defect: 'the required top-level field "displayName" is absent',
    missingField: 'displayName',
    extraEntries: [],
    tamper: null,
  },
];

/** The manifest object for one fixture (mutated per `defect`). */
function manifestFor(fixture) {
  const manifest = {
    manifestVersion: 1,
    id: fixture.id,
    displayName: fixture.displayName,
    version: fixture.version,
    engines: { fredo: fixture.enginesFredo },
    entry: { document: 'index.html', module: 'main.js' },
    description: fixture.description,
  };
  if (fixture.unknownField) {
    // The deliberate defect: a top-level key manifestVersion 1 does not define.
    manifest[fixture.unknownField] = ['read:settings'];
  }
  if (fixture.missingField) {
    // The deliberate defect: a REQUIRED key is absent (never null — an unset
    // optional is an absent key, and a required one is simply missing).
    delete manifest[fixture.missingField];
  }
  return manifest;
}

/** The archive body: fredo-app.json at the root, the entry files, then extras. */
function packageEntries(fixture) {
  const entries = [];
  if (!fixture.omitManifest) {
    entries.push({
      name: 'fredo-app.json',
      data: Buffer.from(JSON.stringify(manifestFor(fixture), null, 2) + '\n', 'utf8'),
    });
  }
  entries.push({
    name: 'index.html',
    data: Buffer.from(documentHtml(fixture.displayName), 'utf8'),
  });
  entries.push({ name: 'main.js', data: Buffer.from(moduleJs(fixture.id), 'utf8') });
  for (const extra of fixture.extraEntries) {
    entries.push({ name: extra.name, data: Buffer.from(extra.data, 'utf8') });
  }
  return entries;
}

/**
 * Per-fixture self-check. Runs on EVERY build (G-314: a gate that never runs is
 * not a gate).
 *
 * The assertions are about INTENT: the valid package must be fully legal, and
 * each refusal package must carry exactly the defect it claims (and nothing
 * else), so a fixture can never silently drift into driving a different code.
 */
function selfCheck(item) {
  const { fixture, entries, archive } = item;
  const problems = [];

  const listed = verifyZip(archive);
  if (listed.length !== entries.length) {
    problems.push(
      'archive read back ' + listed.length + ' entries, expected ' + entries.length
    );
  }

  // The archive's own entry names must match what we meant to write, in order.
  const writtenNames = entries.map((entry) => entry.name);
  const readNames = listed.map((entry) => entry.name);
  if (JSON.stringify(writtenNames) !== JSON.stringify(readNames)) {
    problems.push('entry order/names drifted: ' + JSON.stringify(readNames));
  }

  // 1) The manifest, if present, must round-trip and classify as intended.
  const manifestBytes = readZipEntry(archive, 'fredo-app.json');
  if (fixture.omitManifest) {
    if (manifestBytes) problems.push('this fixture must NOT contain fredo-app.json');
  } else if (!manifestBytes) {
    problems.push('fredo-app.json is missing from the archive');
  } else {
    let parsed = null;
    try {
      parsed = JSON.parse(manifestBytes.toString('utf8'));
    } catch (error) {
      problems.push('fredo-app.json is not valid JSON: ' + error.message);
    }
    if (parsed) {
      const expected = manifestFor(fixture);
      for (const key of Object.keys(expected)) {
        if (JSON.stringify(parsed[key]) !== JSON.stringify(expected[key])) {
          problems.push('manifest field drifted inside the archive: ' + key);
        }
      }
      if (fixture.missingField && Object.prototype.hasOwnProperty.call(parsed, fixture.missingField)) {
        problems.push('this fixture must OMIT "' + fixture.missingField + '"');
      }

      const violation = firstManifestViolation(parsed);
      if (
        fixture.expects === 'manifest_unknown_field' ||
        fixture.expects === 'manifest_invalid_field'
      ) {
        // The defect must be PRESENT, must classify as the recorded code, and
        // must name the recorded field.
        const declaredField = fixture.unknownField ?? fixture.missingField;
        if (violation === null) {
          problems.push('the published schema accepts this manifest, but it must drive ' + fixture.expects);
        } else {
          if (violation.code !== fixture.expects) {
            problems.push('the manifest classifies as ' + violation.code + ', not ' + fixture.expects);
          }
          if (violation.field !== declaredField) {
            problems.push(
              'the refusal names field "' + violation.field + '", expected "' + declaredField + '"',
            );
          }
        }
        // The allowed-key set is the PUBLISHED SCHEMA's (never a hand-typed list:
        // a stale list is exactly how `capabilities` stayed "unknown" after #3146).
        const defined = topLevelKeys();
        if (!defined.includes('capabilities')) {
          problems.push('the published schema must define "capabilities" (the D1 drift class)');
        }
        const unknown = Object.keys(parsed).filter((key) => !defined.includes(key));
        const declaredUnknown = fixture.unknownField ? [fixture.unknownField] : [];
        if (JSON.stringify(unknown) !== JSON.stringify(declaredUnknown)) {
          problems.push(
            'expected exactly the unknown key(s) ' +
              JSON.stringify(declaredUnknown) +
              ', found ' +
              JSON.stringify(unknown),
          );
        }
      } else {
        // Every other fixture's manifest must be schema-legal (the engines RANGE
        // is validated separately below because `>=999.0.0` is a legal range
        // that simply excludes the host).
        if (violation !== null) {
          problems.push(
            'archived manifest: ' +
              violation.code +
              ' ' +
              (violation.field ?? '') +
              ' ' +
              violation.detail,
          );
        }
      }
    }
  }

  // 2) The engine range must classify as intended.
  const range = fixture.enginesFredo;
  const parsedRange = SEMVER_RANGE_RE.test(range);
  if (fixture.expects === 'host_incompatible') {
    if (!parsedRange) problems.push('the incompatible fixture needs a WELL-FORMED range, got ' + range);
    if (range === '*' || range.trim() === '') {
      problems.push('the incompatible fixture must NOT use "*"/empty (that is engines_range_invalid)');
    }
  } else if (range === '*' || range.trim() === '' || !parsedRange) {
    problems.push('only the incompatible fixture may carry a special range; got ' + range);
  }

  // 3) The entry-name intents: extras must be refused, ordinary names must not be.
  for (const entry of entries) {
    const refusal = entryNameRefusal(entry.name);
    const isDeclaredExtra = fixture.extraEntries.some((extra) => extra.name === entry.name);
    if (isDeclaredExtra) {
      if (refusal !== fixture.expects) {
        problems.push(
          'declared extra entry "' + entry.name + '" must drive ' + fixture.expects + ', drives ' + refusal
        );
      }
    } else if (refusal !== null) {
      problems.push(
        'ordinary entry "' + entry.name + '" must be safe, would drive ' + refusal
      );
    }
  }

  // 4) The refusal code must be in the frozen set (or null for the happy path).
  if (fixture.expects !== null && !REFUSAL_CODES.includes(fixture.expects)) {
    problems.push('"' + fixture.expects + '" is not one of the 22 frozen refusal codes');
  }

  // 5) The entry files must be real, non-empty and (for the module) export mount.
  const documentBytes = readZipEntry(archive, 'index.html');
  if (!documentBytes || documentBytes.length === 0) {
    problems.push('index.html is missing or empty');
  } else if (!documentBytes.toString('utf8').includes('<!doctype html>')) {
    problems.push('index.html is not an HTML document');
  }
  const moduleBytes = readZipEntry(archive, 'main.js');
  if (!moduleBytes || moduleBytes.length === 0) {
    problems.push('main.js is missing or empty');
  } else if (!/export function mount\s*\(/.test(moduleBytes.toString('utf8'))) {
    problems.push('main.js does not export the mount function the host calls');
  }

  // 6) The tamper target must exist in the archive at the recorded offset.
  if (fixture.tamper) {
    const target = readZipEntry(archive, fixture.tamper.file);
    if (!target) {
      problems.push('the tamper target ' + fixture.tamper.file + ' is not in the archive');
    } else if (fixture.tamper.offset >= target.length) {
      problems.push(
        'the tamper offset ' + fixture.tamper.offset + ' is past the end of ' + fixture.tamper.file
      );
    }
  }

  return problems;
}

/** A tiny semver-RANGE check: enough to tell a real range from `*`/garbage. */
const SEMVER_RANGE_RE = /^(?:[<>=~^*]=?|\^|~)\s*[0-9]+(?:\.[0-9]+)?(?:\.[0-9]+)?(?:-[0-9A-Za-z.-]+)?(?:\s*[,|]?\s*(?:[<>=~^*]=?\s*)?[0-9]+(?:\.[0-9]+)?(?:\.[0-9]+)?)*$/;

/* ==========================================================================
 * CLI
 * ========================================================================== */

const HELP = `build-package-fixtures.mjs -- Spec #3147 (ST-2) install-validation packages.

Usage:
  node .opencode/tests/installable-apps/fixtures/build-package-fixtures.mjs [options]

Options:
  --out <dir>       output directory (default: .opencode/tmp/3147/fixtures/packages)
  --verify          exit 1 unless the committed expected manifest matches these bytes AND
                    every manifest classifies with the published schema as its recorded code
  --write-expected  (re)write package-fixtures.expected.json beside this script
  --help            this text

Output is deterministic: two runs write byte-identical archives (fixed entry order,
fixed 1980-01-01 DOS timestamp, stored entries). Compare the sha256 column across
runs. Every refusal package's code is recorded in the committed expected manifest
(package-fixtures.expected.json) -- read it from there, never from an assumption.

Manifest validation uses the PUBLISHED schema
(packages/fredo-authoring/schema/fredo-app.schema.json, generated from the Rust
parser), never a hand-written copy: that replacement is drift correction D1.`;

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, verify: false, writeExpected: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--write-expected') options.writeExpected = true;
    else if (arg === '--out') {
      const value = argv[++i];
      if (!value) throw new Error('--out needs a directory');
      options.out = path.resolve(process.cwd(), value);
    } else {
      throw new Error('unknown argument: ' + arg);
    }
  }
  return options;
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Build every archive in memory. Pure -- no filesystem writes. */
function buildAll() {
  const built = [];
  for (const fixture of FIXTURES) {
    const entries = packageEntries(fixture);
    const archive = buildZip(entries);
    const item = {
      fixture,
      entries,
      fileName: fixture.id + '-' + fixture.version + '.zip',
      archive,
      bytes: archive.length,
      sha256: sha256(archive),
      listed: verifyZip(archive),
    };
    const problems = selfCheck(item);
    if (problems.length > 0) {
      throw new Error(item.fileName + ' failed its self-check:\n  - ' + problems.join('\n  - '));
    }
    built.push(item);
  }
  return built;
}

/** The committed expected-output manifest. */
function expectedManifest(built) {
  return {
    description:
      'Committed expected-output manifest for the Spec #3147 ST-2 install-validation ' +
      'packages. Read each fixture id, its refusal code and the bad-manifest defect shape ' +
      'from HERE, never from an assumption: regenerate with ' +
      'node .opencode/tests/installable-apps/fixtures/build-package-fixtures.mjs and confirm ' +
      'with --verify.',
    generator: '.opencode/tests/installable-apps/fixtures/build-package-fixtures.mjs',
    schemaVersion: 1,
    refusalCodes: REFUSAL_CODES,
    zipPolicy: {
      method: 'stored (0)',
      dosTimestamp: '1980-01-01T00:00:00 (dosTime 0x0000, dosDate 0x0021)',
      entryOrder: 'fredo-app.json (omitted for no-manifest), index.html, main.js, then any declared extra',
    },
    fixtures: built.map((item) => ({
      id: item.fixture.id,
      displayName: item.fixture.displayName,
      version: item.fixture.version,
      enginesFredo: item.fixture.enginesFredo,
      file: item.fileName,
      bytes: item.bytes,
      sha256: item.sha256,
      expects: item.fixture.expects,
      // WHERE the code is reached. Every refusal is `install` except
      // hash-tamper, whose `integrity_mismatch` is a LOAD-time refusal: that
      // package INSTALLS cleanly and only the post-install mutation makes the
      // verify (ST-3) refuse. A tester who expects an install-time refusal from
      // it would mis-read a correct install as a defect.
      expectsStage:
        item.fixture.expects === null
          ? 'none (installs cleanly)'
          : item.fixture.expects === 'integrity_mismatch'
            ? 'load (after a post-install byte mutation)'
            : 'install',
      defect: item.fixture.defect,
      ...(item.fixture.unsafeShape ? { unsafeShape: item.fixture.unsafeShape } : {}),
      ...(item.fixture.unknownField ? { badManifestShape: item.fixture.unknownField } : {}),
      ...(item.fixture.missingField ? { missingField: item.fixture.missingField } : {}),
      ...(item.fixture.tamper ? { tamper: item.fixture.tamper } : {}),
      entries: item.listed.map((entry) => ({ name: entry.name, bytes: entry.bytes })),
    })),
  };
}

/**
 * Which fixtures' expected code is decided by the MANIFEST (and therefore must
 * match the published schema's classification). The rest are decided by the
 * archive rules (`unsafe_path`, `reserved_path`), by the zip's absence of a
 * manifest (`no_manifest`), or at load time (`integrity_mismatch`).
 */
const MANIFEST_CLASSIFIABLE_CODES = new Set([
  'manifest_malformed',
  'manifest_unknown_field',
  'manifest_invalid_field',
  'unsupported_manifest_version',
  'id_invalid',
  'id_reserved',
  'version_invalid',
  'engines_range_invalid',
]);

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }

  // Fail before writing anything if the catalog itself is inconsistent: every
  // fixture must name a frozen code (or the happy path), and the codes must be
  // exactly the 22 the plan freezes.
  const catalogProblems = [];
  if (REFUSAL_CODES.length !== 22) {
    catalogProblems.push('the frozen refusal vocabulary must have 22 codes, has ' + REFUSAL_CODES.length);
  }
  for (const fixture of FIXTURES) {
    if (fixture.expects !== null && !REFUSAL_CODES.includes(fixture.expects)) {
      catalogProblems.push(fixture.id + ' expects an unknown code ' + fixture.expects);
    }
  }
  const codesExpecting = FIXTURES.map((fixture) => fixture.expects).filter((code) => code !== null);
  for (const required of ['no_manifest', 'manifest_unknown_field', 'manifest_invalid_field', 'unsafe_path', 'host_incompatible', 'reserved_path', 'integrity_mismatch']) {
    if (!codesExpecting.includes(required)) {
      catalogProblems.push('no fixture drives the required code ' + required);
    }
  }
  if (catalogProblems.length > 0) {
    for (const problem of catalogProblems) console.error('CATALOG ERROR: ' + problem);
    process.exitCode = 1;
    return;
  }

  const built = buildAll();
  const expected = expectedManifest(built);

  if (options.verify) {
    let committed;
    try {
      committed = JSON.parse(readFileSync(EXPECTED_PATH, 'utf8'));
    } catch (error) {
      console.error('VERIFY FAILED: cannot read ' + EXPECTED_PATH + ': ' + error.message);
      process.exitCode = 1;
      return;
    }
    const committedById = new Map(committed.fixtures.map((item) => [item.id, item]));
    const problems = [];
    for (const item of expected.fixtures) {
      const known = committedById.get(item.id);
      if (!known) {
        problems.push('missing from the committed manifest: ' + item.id);
        continue;
      }
      if (known.sha256 !== item.sha256) {
        problems.push(
          'sha256 drift for ' + item.id + ': committed ' + known.sha256 + ', built ' + item.sha256
        );
      }
      if (known.expects !== item.expects) {
        problems.push(
          'expected-code drift for ' + item.id + ': ' + known.expects + ' -> ' + item.expects
        );
      }
    }
    // The SCHEMA-DRIFT leg (Spec #3145 ST-2): every fixture whose expected code
    // is decided by the MANIFEST must classify with the published schema as that
    // exact code, and every other fixture's manifest must be schema-legal. This
    // is the leg that could not have passed before D1's repair: `capabilities`
    // classified as manifest_invalid_field while the corpus recorded
    // manifest_unknown_field.
    for (const builtItem of built) {
      const fixture = builtItem.fixture;
      const violation = firstManifestViolation(manifestFor(fixture));
      if (MANIFEST_CLASSIFIABLE_CODES.has(fixture.expects)) {
        if (violation === null || violation.code !== fixture.expects) {
          problems.push(
            'schema-classification drift for ' +
              fixture.id +
              ': the corpus records ' +
              fixture.expects +
              ', the published schema says ' +
              (violation === null ? 'no violation' : violation.code + ' (field ' + (violation.field ?? 'none') + ')')
          );
        }
      } else if (violation !== null) {
        problems.push(
          'schema drift for ' +
            fixture.id +
            ": its manifest must be schema-legal, the published schema says " +
            violation.code +
            ' ' +
            (violation.field ?? '')
        );
      }
    }
    for (const id of committedById.keys()) {
      if (!expected.fixtures.some((item) => item.id === id)) {
        problems.push('the committed manifest names a fixture this generator no longer builds: ' + id);
      }
    }
    if (problems.length > 0) {
      console.error('VERIFY FAILED:');
      for (const problem of problems) console.error('  - ' + problem);
      process.exitCode = 1;
      return;
    }
    console.log('VERIFY OK: ' + expected.fixtures.length + ' fixtures match ' + EXPECTED_PATH);
    return;
  }

  if (options.writeExpected) {
    writeFileSync(EXPECTED_PATH, JSON.stringify(expected, null, 2) + '\n', 'utf8');
    console.log('WROTE ' + EXPECTED_PATH);
    console.log('');
  }

  mkdirSync(options.out, { recursive: true });
  for (const item of built) {
    writeFileSync(path.join(options.out, item.fileName), item.archive);
  }

  const summaryLines = [
    'Spec #3147 (ST-2) install-validation packages',
    'generated by .opencode/tests/installable-apps/fixtures/build-package-fixtures.mjs',
    '',
    'output directory: ' + options.out,
    '',
    pad('id', 32) + pad('expects', 26) + pad('zip', 40) + pad('bytes', 8) + 'sha256',
    pad('--', 32) + pad('-------', 26) + pad('---', 40) + pad('-----', 8) + '------',
  ];
  for (const item of built) {
    summaryLines.push(
      pad(item.fixture.id, 32) +
        pad(item.fixture.expects === null ? '(installs)' : item.fixture.expects, 26) +
        pad(item.fileName, 40) +
        pad(item.bytes, 8) +
        item.sha256
    );
  }
  writeFileSync(path.join(options.out, 'PACKAGE-FIXTURES.txt'), summaryLines.join('\n') + '\n', 'utf8');

  console.log('PACKAGE FIXTURES (Spec #3147 ST-2)');
  console.log('output directory: ' + options.out);
  console.log('');
  console.log(pad('id', 32) + pad('expects', 26) + pad('zip', 40) + pad('bytes', 8) + 'sha256');
  console.log(pad('--', 32) + pad('-------', 26) + pad('---', 40) + pad('-----', 8) + '------');
  for (const item of built) {
    console.log(
      pad(item.fixture.id, 32) +
        pad(item.fixture.expects === null ? '(installs)' : item.fixture.expects, 26) +
        pad(item.fileName, 40) +
        pad(item.bytes, 8) +
        item.sha256
    );
  }
  console.log('');
  for (const item of built) {
    console.log(item.fixture.id + ' entries (' + item.listed.length + '):');
    for (const entry of item.listed) {
      console.log('  ' + entry.name + '  ' + entry.bytes + ' bytes  crc32=' + entry.crc32);
    }
  }
  console.log('');
  console.log('built ' + built.length + ' archives (' + FIXTURES.length + ' required)');
  console.log(
    'codes driven: ' +
      built
        .map((item) => (item.fixture.expects === null ? '(installs)' : item.fixture.expects))
        .join(', ')
  );
}

/** The catalog + manifest projection, exported for the kit's conformance test. */
export { FIXTURES, MANIFEST_CLASSIFIABLE_CODES, REFUSAL_CODES, firstManifestViolation, manifestFor };

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main();
}
