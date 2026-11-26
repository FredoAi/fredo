// The external-developer exam runner (#3145 ST-6).
//
// WHAT THIS IS
//   A committed, failable instrument. It reproduces the documented authoring path
//   (`docs/authoring-applications.md`, steps S1-help … S6-specifiers) against a
//   COPY of the published kit, inside one scratch root, and prints a fixed-shape
//   transcript a verdict can quote verbatim.
//
// OUTPUT GRAMMAR (the only thing that reaches stdout):
//
//   STEP <step-id> cmd=<command verbatim> exit=<code> artifact=<path|none> sha256=<hex|none>
//   EXAM <CHECK-ID> PASS|FAIL <detail>
//   EXAM SUMMARY steps=<n> failed-steps=<n> checks=<n> failed=<n> verdict=<PASS|FAIL>
//
//   Exit status is 0 iff verdict=PASS. A failing check does not stop the run, so
//   one run reports every failed clause.
//
// THE KEY-HOLDER SEPARATION (and its honest limit)
//   The exam is meant to run as an agent whose read access is denied for the repo
//   and allowed only for the scratch root. That profile cannot be created by this
//   script, and a process cannot prove it about its caller. So the AUTHOR's denial
//   control — the verbatim outcome of an attempt to read
//   apps/tauri/src-tauri/src/applications/installed_apps/manifest.rs lines 91-100
//   — is an INPUT:
//     * `DENIED: …`     -> the leg is scored permission-isolated.
//     * `ALLOWED: …`    -> the leg is scored brief-restricted, NOT permission-isolated.
//     * absent          -> the leg is VOID (not a pass, not a fail): INPUTS FAILs
//                          with the VOID reason, per F1d.
//   The runner never reads the repo itself. Every path it opens is asserted inside
//   the two allowed roots (kit/, work/) or the out/ root, BEFORE it is opened.
//
// WHAT IT DOES NOT DO
//   It never authors the application (the author writes `work/my-app/`; this script
//   only vendors the theme and inspects the result), never installs (S5 records the
//   operator/tester receipt), and never reads anything outside its roots.
//
// USAGE (all flags optional; defaults are the plan's scratch roots):
//   node .opencode/tests/installable-apps/authoring-exam.mjs \
//     [--kit <dir>] [--work <dir>] [--out <dir>] \
//     [--denial-control "<DENIED: …|ALLOWED: …>"] [--install-receipt <file>]
//
// Node built-ins only. No shebang: this file is only ever run as `node <file>`.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..', '..', '..');
const SCRATCH = path.join(REPO_ROOT, '.opencode', 'tmp', '3145', 'external-author');

/** The two allowed INPUT roots, plus the output root the runner writes. */
const ROOTS = Object.freeze({
  kit: path.join(SCRATCH, 'kit'),
  work: path.join(SCRATCH, 'work'),
  out: path.join(SCRATCH, 'out'),
});

/** Host-internal shapes an author must never import (F-8.3 / F-8.14). */
const HOST_INTERNAL_TOKENS = Object.freeze([
  '@/',
  'apps/ui',
  'FredoApplicationClass',
  'registerApplication',
]);

/** Step commands must never name a Fredo checkout (F-8.2 / F1a). */
const CHECKOUT_TOKENS = Object.freeze([
  'apps/',
  'packages/',
  'apps\\',
  'packages\\',
  'pnpm --filter',
  'cargo',
  '@/shared',
]);

const steps = [];
const checks = [];

function emit(line) {
  process.stdout.write(line + '\n');
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Render a path with forward slashes (for the `cmd=` transcript line). */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

function existsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function existsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True iff `candidate` resolves inside `root`. Both are compared as absolute
 * paths; the real path is used when it exists so a symlink cannot smuggle a
 * read outside the root.
 */
function isInside(root, candidate) {
  let rootAbs = path.resolve(root);
  let candidateAbs = path.resolve(candidate);
  try {
    rootAbs = fs.realpathSync(rootAbs);
  } catch {
    /* the root may not exist yet; the lexical path still bounds the input */
  }
  try {
    candidateAbs = fs.realpathSync(candidateAbs);
  } catch {
    /* non-existent output paths are bounded lexically */
  }
  const rel = path.relative(rootAbs, candidateAbs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Assert-and-throw wrapper: no read below ever touches a path outside the roots. */
function assertInside(root, candidate, label) {
  if (!isInside(root, candidate)) {
    throw new Error(`${label} resolves outside its allowed root: ${path.resolve(candidate)}`);
  }
}

function walkFiles(root) {
  const found = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') {
          found.push({ path: full, nodeModules: true });
        } else {
          visit(full);
        }
      } else if (entry.isFile()) {
        found.push({ path: full, nodeModules: false });
      }
    }
  };
  visit(root);
  return found;
}

/** Extract module specifiers from JS source, ignoring line comments. */
function specifiersIn(source) {
  const text = source
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
  const specs = [];
  const patterns = [
    /(?:^|[^.\w$])(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(text)) !== null) {
      specs.push(match[1]);
    }
  }
  return specs;
}

/** Read the entry names out of a stored zip's central directory. */
function zipEntryNames(file) {
  const buffer = fs.readFileSync(file);
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`central-directory entry ${i} has a bad signature`);
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function recordStep(id, cmd, code, artifact, digest) {
  const exitCode = Number.isInteger(code) ? code : 1;
  steps.push({ id, cmd, exit: exitCode });
  emit(
    `STEP ${id} cmd=${cmd} exit=${exitCode} ` +
      `artifact=${artifact ?? 'none'} sha256=${digest ?? 'none'}`
  );
}

function recordCheck(id, ok, detail) {
  checks.push({ id, ok: Boolean(ok), detail });
  emit(`EXAM ${id} ${ok ? 'PASS' : 'FAIL'} ${detail}`);
}

function summarizeAndExit() {
  const failedSteps = steps.filter((step) => step.exit !== 0).length;
  const failedChecks = checks.filter((check) => !check.ok).length;
  const verdict = failedSteps === 0 && failedChecks === 0 && checks.length > 0 ? 'PASS' : 'FAIL';
  emit(
    `EXAM SUMMARY steps=${steps.length} failed-steps=${failedSteps} ` +
      `checks=${checks.length} failed=${failedChecks} verdict=${verdict}`
  );
  process.exit(verdict === 'PASS' ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const parsed = { kit: ROOTS.kit, work: ROOTS.work, out: ROOTS.out, denial: null, receipt: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stderr.write(
        'usage: node authoring-exam.mjs [--kit <dir>] [--work <dir>] [--out <dir>] ' +
          '[--denial-control "<DENIED: …|ALLOWED: …>"] [--install-receipt <file>]\n'
      );
      process.exit(0);
    }
    const value = argv[i + 1];
    if (arg === '--kit' && value) {
      parsed.kit = path.resolve(value);
      i += 1;
    } else if (arg === '--work' && value) {
      parsed.work = path.resolve(value);
      i += 1;
    } else if (arg === '--out' && value) {
      parsed.out = path.resolve(value);
      i += 1;
    } else if (arg === '--denial-control' && value) {
      parsed.denial = value;
      i += 1;
    } else if (arg === '--install-receipt' && value) {
      parsed.receipt = path.resolve(value);
      i += 1;
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// SELF-CHECK — refuse to start when any input escapes its allowed root.
// It runs BEFORE S1-help and prints only the line + the summary.
// ---------------------------------------------------------------------------
const rootProblems = [];
for (const [name, root, value] of [
  ['kit', ROOTS.kit, args.kit],
  ['work', ROOTS.work, args.work],
  ['out', ROOTS.out, args.out],
]) {
  if (!isInside(root, value)) {
    rootProblems.push(`${name}=${value} escapes ${root}`);
  }
}
if (args.receipt !== null && !isInside(ROOTS.work, args.receipt) && !isInside(ROOTS.out, args.receipt)) {
  rootProblems.push(`install-receipt=${args.receipt} escapes work/ and out/`);
}

if (rootProblems.length > 0) {
  recordCheck('SELF-CHECK', false, rootProblems.join('; '));
  summarizeAndExit();
}

recordCheck(
  'SELF-CHECK',
  true,
  `kit=${args.kit}; work=${args.work}; out=${args.out}; all inside ${SCRATCH}`
);

const kitApp = path.join(args.kit, 'fredo-authoring', 'bin', 'fredo-app.mjs');
const kitThemeDist = path.join(args.kit, 'fredo-theme', 'dist');
const appDir = path.join(args.work, 'my-app');
const vendorDir = path.join(appDir, 'vendor', 'fredo-theme');

// ---------------------------------------------------------------------------
// S1-help — the kit resolves and lists exactly two verbs.
// ---------------------------------------------------------------------------
const s1 = spawnSync(process.execPath, [kitApp, '--help'], {
  cwd: args.work,
  encoding: 'utf8',
  timeout: 60_000,
});
recordStep('S1-help', `node ${kitApp} --help`, s1.status, null, null);

const helpText = `${s1.stdout ?? ''}\n${s1.stderr ?? ''}`;
const helpListsBothVerbs = /\bcheck\b/.test(helpText) && /\bpack\b/.test(helpText);

// ---------------------------------------------------------------------------
// S2-author — vendor the published theme, then assert the author's files exist.
// The copy is the documented command; the three application files are the
// author's own work (the runner never writes them — a committed template would
// let the exam copy instead of read).
// ---------------------------------------------------------------------------
fs.mkdirSync(path.join(appDir, 'vendor'), { recursive: true });
assertInside(ROOTS.work, vendorDir, 'vendor target');
const vendorCmd =
  `node --eval "require('node:fs').cpSync('${toPosix(kitThemeDist)}', ` +
  `'${toPosix(vendorDir)}', { recursive: true })"`;
const s2 = spawnSync(
  process.execPath,
  [
    '--eval',
    `require('node:fs').cpSync(${JSON.stringify(kitThemeDist)}, ` +
      `${JSON.stringify(vendorDir)}, { recursive: true })`,
  ],
  { cwd: args.work, encoding: 'utf8', timeout: 60_000 }
);

const authored = ['fredo-app.json', 'index.html', 'main.js'].map((name) => path.join(appDir, name));
const missing = authored.filter((file) => !existsFile(file));
const vendorIndex = path.join(vendorDir, 'index.mjs');
const s2Exit = s2.status !== 0 ? s2.status : missing.length > 0 || !existsFile(vendorIndex) ? 1 : 0;
recordStep(
  'S2-author',
  vendorCmd,
  s2Exit,
  existsFile(vendorIndex) ? vendorIndex : null,
  existsFile(vendorIndex) ? sha256(vendorIndex) : null
);

// ---------------------------------------------------------------------------
// S3-check — validate the authored package; keep the JSON payload.
// ---------------------------------------------------------------------------
const checkCmd = `node ${kitApp} check ${appDir} --json`;
const s3 = spawnSync(process.execPath, [kitApp, 'check', appDir, '--json'], {
  cwd: args.work,
  encoding: 'utf8',
  timeout: 60_000,
});
const checkPayloadPath = path.join(args.out, 'check.json');
fs.mkdirSync(args.out, { recursive: true });
assertInside(ROOTS.out, checkPayloadPath, 'check payload');
try {
  fs.writeFileSync(checkPayloadPath, s3.stdout ?? '');
} catch {
  /* a missing payload is reported by CHECK-CLEAN, not thrown */
}
recordStep(
  'S3-check',
  checkCmd,
  s3.status,
  existsFile(checkPayloadPath) ? checkPayloadPath : null,
  existsFile(checkPayloadPath) ? sha256(checkPayloadPath) : null
);

let checkClean = false;
let checkDetail = 'check did not exit 0';
if (s3.status === 0) {
  try {
    const parsed = JSON.parse(s3.stdout ?? '');
    const violations = Array.isArray(parsed.violations) ? parsed.violations : null;
    if (violations && violations.length === 0) {
      checkClean = true;
      checkDetail = 'violations: [] (exit 0)';
    } else {
      checkDetail = `violations=${JSON.stringify(violations ?? parsed.violations ?? null)}`;
    }
  } catch (error) {
    checkDetail = `check output is not JSON: ${error.message}`;
  }
}

// ---------------------------------------------------------------------------
// S4-pack — pack twice to two distinct paths; the digests must agree.
// The FIRST pack writes the file S5 installs, so the second must not touch it.
// ---------------------------------------------------------------------------
const packA = path.join(args.out, 'my-app.zip');
const packB = path.join(args.out, 'my-app-b.zip');
const packCmdA = `node ${kitApp} pack ${appDir} --out ${packA}`;
const packCmdB = `node ${kitApp} pack ${appDir} --out ${packB}`;
const s4a = spawnSync(process.execPath, [kitApp, 'pack', appDir, '--out', packA], {
  cwd: args.work,
  encoding: 'utf8',
  timeout: 120_000,
});
recordStep('S4-pack', packCmdA, s4a.status, existsFile(packA) ? packA : null, existsFile(packA) ? sha256(packA) : null);
const s4b = spawnSync(process.execPath, [kitApp, 'pack', appDir, '--out', packB], {
  cwd: args.work,
  encoding: 'utf8',
  timeout: 120_000,
});
recordStep('S4-pack', packCmdB, s4b.status, existsFile(packB) ? packB : null, existsFile(packB) ? sha256(packB) : null);

const digestA = existsFile(packA) ? sha256(packA) : null;
const digestB = existsFile(packB) ? sha256(packB) : null;

// ---------------------------------------------------------------------------
// S5-install — a recorded receipt from the live install (never fabricated here).
// The receipt is a small key=value file the tester/operator writes after driving
// Settings → Installed applications → Install application package… and opening
// the window: `installed=true`, `window=installed-<id>`, `painted=true`.
// ---------------------------------------------------------------------------
const receiptPath = args.receipt ?? path.join(args.work, 'install-receipt.txt');
const receiptCmd =
  'Settings > Installed applications > Install application package... > out/my-app.zip > open the window';
if (existsFile(receiptPath)) {
  assertInside(ROOTS.work, receiptPath, 'install receipt');
  const text = fs.readFileSync(receiptPath, 'utf8');
  const readValue = (key) => (text.match(new RegExp(`^${key}=(.+)$`, 'm')) ?? [])[1]?.trim() ?? '';
  const installed = readValue('installed') === 'true';
  const windowLabel = readValue('window');
  const painted = readValue('painted') === 'true';
  const ok = installed && painted && windowLabel.startsWith('installed-');
  recordStep('S5-install', receiptCmd, ok ? 0 : 1, null, null);
} else {
  recordStep('S5-install', receiptCmd, 78, null, null);
}

// ---------------------------------------------------------------------------
// S6-specifiers — the package is self-contained: relative specifiers only, each
// resolving to a file the zip carries; zero host-internal tokens.
// ---------------------------------------------------------------------------
const scanCmd = `runner:specifier-scan(${appDir})`;
const specProblems = [];
const importsSeen = [];
let zipNames = null;
try {
  zipNames = existsFile(packA) ? zipEntryNames(packA) : null;
} catch (error) {
  specProblems.push(`zip entry list unreadable: ${error.message}`);
}

const authoredJs = walkFiles(appDir).filter(
  (file) => !file.nodeModules && /\.(mjs|cjs|js|ts|tsx|jsx)$/.test(file.path)
);
if (authoredJs.length === 0) {
  specProblems.push('no application module found — the scan would be vacuous');
}

for (const file of authoredJs) {
  let source;
  try {
    source = fs.readFileSync(file.path, 'utf8');
  } catch {
    continue;
  }
  for (const token of HOST_INTERNAL_TOKENS) {
    if (source.includes(token)) {
      specProblems.push(`host-internal token ${JSON.stringify(token)} in ${file.path}`);
    }
  }
  for (const specifier of specifiersIn(source)) {
    importsSeen.push(`${path.relative(appDir, file.path)} -> ${specifier}`);
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      specProblems.push(`non-relative specifier ${JSON.stringify(specifier)} in ${file.path}`);
      continue;
    }
    const target = path.resolve(path.dirname(file.path), specifier);
    const rel = path.relative(appDir, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      specProblems.push(`specifier ${JSON.stringify(specifier)} resolves outside the package`);
      continue;
    }
    if (!existsFile(target)) {
      specProblems.push(`specifier ${JSON.stringify(specifier)} resolves to a missing file`);
      continue;
    }
    if (zipNames && !zipNames.includes(rel.split(path.sep).join('/'))) {
      specProblems.push(`specifier ${JSON.stringify(specifier)} targets a file the zip does not carry`);
    }
  }
}
// A zero-import scan is not evidence: the documented sample imports its vendored
// theme, so an app with no module specifier at all means nothing was authored (G-469).
const specifiersOk = specProblems.length === 0 && importsSeen.length > 0;
if (specProblems.length === 0 && importsSeen.length === 0) {
  specProblems.push('no module specifier found; the sample imports its vendored theme (vacuous scan)');
}
recordStep('S6-specifiers', scanCmd, specifiersOk ? 0 : 1, null, null);

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
// INPUTS — every resolved input inside its root, and the author's denial control.
let denialText = args.denial;
if (!denialText && existsFile(path.join(args.work, 'denial-control.txt'))) {
  denialText = fs.readFileSync(path.join(args.work, 'denial-control.txt'), 'utf8').trim();
}
const inputDetail =
  `kit=${isInside(ROOTS.kit, args.kit) ? 'in-root' : 'ESCAPED'} ` +
  `work=${isInside(ROOTS.work, args.work) ? 'in-root' : 'ESCAPED'} ` +
  `out=${isInside(ROOTS.out, args.out) ? 'in-root' : 'ESCAPED'}; `;
if (!denialText) {
  recordCheck('INPUTS', false, `${inputDetail}denial control absent — leg VOID (F1d), not a pass`);
} else if (/^DENIED\b/i.test(denialText)) {
  recordCheck('INPUTS', true, `${inputDetail}denial control: ${denialText}`);
} else {
  recordCheck(
    'INPUTS',
    false,
    `${inputDetail}denial control: ${denialText} — brief-restricted, NOT permission-isolated`
  );
}

// DOCUMENTED-PATH — every executed command is a documented one and names no checkout.
const commandLines = steps.map((step) => step.cmd);
const offending = commandLines.find((cmd) => CHECKOUT_TOKENS.some((token) => cmd.includes(token)));
const documentedHelpOk =
  steps.find((step) => step.id === 'S1-help')?.exit === 0 && helpListsBothVerbs;
const documentedPathOk = !offending && documentedHelpOk;
recordCheck(
  'DOCUMENTED-PATH',
  documentedPathOk,
  offending
    ? `first offending step: ${offending}`
    : `commands=${commandLines.length}; --help exit=${steps.find((s) => s.id === 'S1-help')?.exit}; ` +
      `lists check+pack=${helpListsBothVerbs}; zero checkout tokens`
);

// CHECK-CLEAN — the --json payload from S3-check.
recordCheck('CHECK-CLEAN', checkClean, checkDetail);

// DETERMINISM — two packs, two paths, one digest.
const determinismOk = Boolean(digestA) && digestA === digestB;
recordCheck(
  'DETERMINISM',
  determinismOk,
  `my-app.zip=${digestA ?? 'none'}; my-app-b.zip=${digestB ?? 'none'}; equal=${determinismOk}`
);

// SPECIFIERS — S6's scan.
recordCheck(
  'SPECIFIERS',
  specifiersOk,
  specifiersOk
    ? `imports=${importsSeen.length}; all relative and present in the zip; zero host-internal tokens`
    : specProblems.join('; ')
);

// NO-NODE-MODULES — the kit needs no installed dependency.
const kitFiles = walkFiles(args.kit);
const nodeModulesDirs = kitFiles.filter((file) => file.nodeModules).map((file) => file.path);
const bareSpecifiers = [];
for (const file of kitFiles) {
  if (file.nodeModules) continue;
  if (!/\.(mjs|cjs|js)$/.test(file.path)) continue;
  let source;
  try {
    source = fs.readFileSync(file.path, 'utf8');
  } catch {
    continue;
  }
  for (const specifier of specifiersIn(source)) {
    const bare =
      !specifier.startsWith('.') &&
      !specifier.startsWith('/') &&
      !specifier.startsWith('node:');
    if (bare) bareSpecifiers.push(`${path.relative(args.kit, file.path)}: ${specifier}`);
  }
}
const dependencyProblems = [];
for (const pkg of ['fredo-theme', 'fredo-authoring']) {
  const manifest = path.join(args.kit, pkg, 'package.json');
  if (!existsFile(manifest)) {
    dependencyProblems.push(`${pkg}/package.json absent`);
    continue;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const deps = parsed.dependencies;
    if (deps && Object.keys(deps).length > 0) {
      dependencyProblems.push(`${pkg}/package.json declares dependencies ${JSON.stringify(Object.keys(deps))}`);
    }
  } catch (error) {
    dependencyProblems.push(`${pkg}/package.json unreadable: ${error.message}`);
  }
}
const noNodeModulesOk =
  nodeModulesDirs.length === 0 && bareSpecifiers.length === 0 && dependencyProblems.length === 0;
recordCheck(
  'NO-NODE-MODULES',
  noNodeModulesOk,
  noNodeModulesOk
    ? `node_modules dirs=0; non-node: specifiers=0; runtime dependencies=0`
    : [
        nodeModulesDirs.length ? `node_modules at ${nodeModulesDirs.join(', ')}` : null,
        bareSpecifiers.length ? `bare specifiers: ${bareSpecifiers.join('; ')}` : null,
        dependencyProblems.length ? dependencyProblems.join('; ') : null,
      ]
        .filter(Boolean)
        .join('; ')
);

summarizeAndExit();
