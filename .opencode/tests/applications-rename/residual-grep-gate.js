#!/usr/bin/env node
/*
 * residual-grep-gate.js -- residual "feature-sense" grep gate (issue 2956).
 *
 * Sub-task ST-6 / QA-3. Consumes the committed allowlist next to this file
 * (`.opencode/tests/applications-rename/grep-allowlist.txt`, ST-1 Phase-0 names
 * freeze) and FAILS (exit 1) on any [Ff]eature occurrence that is not retained
 * by an allowlist entry, over the renamed product/copy surfaces:
 *
 *   apps/ui/src/applications/**
 *   apps/ui/src/shared/**
 *   apps/tauri/src-tauri/src/applications/**
 *   apps/tauri/src-tauri/src/infrastructure/**
 *   docs/**                (docs/agentic-pipeline/** retained via path rule)
 *
 * Allowlist grammar (see grep-allowlist.txt):
 *   lit:<text>   retained literal substring; a line containing it is retained
 *   re:<regex>   retained when this ECMAScript regex matches the line
 *   path:<glob>  every occurrence in a repo-relative path matching the glob
 *   in:<glob> lit:<text> | in:<glob> re:<regex>
 *                a `lit:`/`re:` rule that applies ONLY to files whose path
 *                matches the glob (used to scope retained identifiers)
 *
 * Matching is case-sensitive. An occurrence is retained when its file path
 * matches a `path:` glob (and the path allowlist is enabled) OR the line that
 * contains it satisfies at least one `lit:`/`re:` entry.
 *
 * CLI:
 *   node residual-grep-gate.js                     run the gate over the scope
 *   node residual-grep-gate.js --json              machine-readable findings
 *   node residual-grep-gate.js --scope <a,b,...>   override the scan roots
 *   node residual-grep-gate.js --ignore-path-allowlist
 *                                                  do not apply `path:` rules
 *   node residual-grep-gate.js --selftest          inject feature_zzz_probe and
 *                                                  assert the gate flags it
 *
 * Exit codes: 0 = clean (no un-allowlisted occurrence); 1 = findings; 2 = error.
 *
 * ASCII-only (G-315): no non-ASCII characters.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ALLOWLIST_PATH = path.join(__dirname, 'grep-allowlist.txt');

const DEFAULT_SCOPE = [
  'apps/ui/src/applications',
  'apps/ui/src/shared',
  'apps/tauri/src-tauri/src/applications',
  'apps/tauri/src-tauri/src/infrastructure',
  'docs',
];

const SKIP_DIRS = new Set([
  'node_modules', 'target', 'dist', 'build', 'coverage', '.git', '.worktrees',
]);

const OCCURRENCE_RE = /[Ff]eature/;

function parseArgs(argv) {
  const opts = {
    json: false,
    summary: false,
    tokens: false,
    scope: null,
    ignorePathAllowlist: false,
    selftest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--summary') opts.summary = true;
    else if (a === '--tokens') opts.tokens = true;
    else if (a === '--ignore-path-allowlist') opts.ignorePathAllowlist = true;
    else if (a === '--selftest') opts.selftest = true;
    else if (a === '--scope') {
      opts.scope = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      throw new Error('unknown argument: ' + a);
    }
  }
  return opts;
}

function parseAllowlist(file) {
  const lits = [];
  const res = [];
  const paths = [];
  const scoped = [];
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const scopedMatch = line.match(/^in:(\S+)\s+(lit|re):(.+)$/);
    if (scopedMatch) {
      if (scopedMatch[2] === 're') {
        try {
          scoped.push({ glob: globToRegExp(scopedMatch[1]), re: new RegExp(scopedMatch[3]) });
        } catch (e) {
          throw new Error('invalid scoped regex: ' + line + ' (' + e.message + ')');
        }
      } else {
        scoped.push({ glob: globToRegExp(scopedMatch[1]), lit: scopedMatch[3] });
      }
      continue;
    }
    if (line.startsWith('lit:')) {
      lits.push(line.slice(4));
    } else if (line.startsWith('re:')) {
      try {
        res.push(new RegExp(line.slice(3)));
      } catch (e) {
        throw new Error('invalid allowlist regex: ' + line + ' (' + e.message + ')');
      }
    } else if (line.startsWith('path:')) {
      paths.push(globToRegExp(line.slice(5)));
    } else {
      throw new Error('invalid allowlist directive: ' + line);
    }
  }
  return { lits, res, paths, scoped };
}

function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        // swallow a single following '/' so `a/**` also matches `a`
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out);
}

function walk(root, out) {
  let st;
  try {
    st = fs.statSync(root);
  } catch (e) {
    return; // missing scope root is fine (e.g. pre-rename trees)
  }
  if (st.isFile()) {
    out.push(root);
    return;
  }
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(path.join(root, ent.name), out);
    } else if (ent.isFile()) {
      out.push(path.join(root, ent.name));
    }
  }
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/');
}

function scanFile(file, allow, ignorePathAllowlist, findings) {
  const relPath = rel(file);
  if (!ignorePathAllowlist && allow.paths.some((g) => g.test(relPath))) return;
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return;
  }
  if (looksBinary(buf)) return;
  const lines = buf.toString('utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!OCCURRENCE_RE.test(line)) continue;
    if (allow.lits.some((l) => line.includes(l))) continue;
    if (allow.res.some((r) => r.test(line))) continue;
    if (allow.scoped.some((s) => s.glob.test(relPath) && (s.lit !== undefined ? line.includes(s.lit) : s.re.test(line)))) continue;
    findings.push({
      file: relPath,
      line: i + 1,
      text: line.trim().slice(0, 200),
    });
  }
}

function runGate(opts) {
  const allow = parseAllowlist(ALLOWLIST_PATH);
  const scope = (opts.scope && opts.scope.length ? opts.scope : DEFAULT_SCOPE)
    .map((s) => path.resolve(REPO_ROOT, s));
  const files = [];
  for (const root of scope) walk(root, files);

  const findings = [];
  for (const f of files) scanFile(f, allow, opts.ignorePathAllowlist, findings);
  return { files: files.length, findings };
}

function selftest() {
  const probeDir = path.join(REPO_ROOT, '.opencode', 'tmp', '2956');
  fs.mkdirSync(probeDir, { recursive: true });
  const probeFile = path.join(probeDir, 'feature_zzz_probe.probe');
  fs.writeFileSync(probeFile, 'feature_zzz_probe\n', 'utf8');
  let result;
  try {
    result = runGate({ scope: [probeFile], ignorePathAllowlist: true });
  } finally {
    try { fs.unlinkSync(probeFile); } catch (e) { /* best effort */ }
  }
  const flagged = result.findings.some(
    (f) => f.file.endsWith('feature_zzz_probe.probe') && f.text.includes('feature_zzz_probe'),
  );
  if (flagged) {
    console.log('SELFTEST PASS: feature_zzz_probe was flagged (no blanket feature_ entry)');
    return 0;
  }
  console.log('SELFTEST FAIL: feature_zzz_probe was NOT flagged -- allowlist masks a generic prefix');
  for (const f of result.findings) console.log('  ' + f.file + ':' + f.line + '  ' + f.text);
  return 1;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('ERROR: ' + e.message);
    return 2;
  }
  try {
    if (opts.selftest) return selftest();

    const result = runGate(opts);
    if (opts.json) {
      console.log(JSON.stringify({
        scannedFiles: result.files,
        unallowlisted: result.findings,
        total: result.findings.length,
      }, null, 2));
    } else if (opts.tokens) {
      const byToken = new Map();
      const tokenRe = /[A-Za-z0-9_$]*[Ff]eature[A-Za-z0-9_$]*/g;
      for (const f of result.findings) {
        const toks = f.text.match(tokenRe) || [];
        for (const t of toks) byToken.set(t, (byToken.get(t) || 0) + 1);
      }
      for (const [tok, count] of [...byToken.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(String(count).padStart(5) + '  ' + tok);
      }
      console.log('----');
      console.log('distinct tokens: ' + byToken.size);
      return result.findings.length === 0 ? 0 : 1;
    } else if (opts.summary) {
      const byFile = new Map();
      for (const f of result.findings) {
        byFile.set(f.file, (byFile.get(f.file) || 0) + 1);
      }
      for (const [file, count] of [...byFile.entries()].sort()) {
        console.log(String(count).padStart(4) + '  ' + file);
      }
      console.log('----');
      console.log('scanned files: ' + result.files);
      console.log('files with findings: ' + byFile.size);
      console.log('un-allowlisted occurrences: ' + result.findings.length);
      return result.findings.length === 0 ? 0 : 1;
    } else {
      for (const f of result.findings) {
        console.log(f.file + ':' + f.line + ': ' + f.text);
      }
      console.log('----');
      console.log('scanned files: ' + result.files);
      console.log('un-allowlisted occurrences: ' + result.findings.length);
      if (result.findings.length === 0) {
        console.log('RESULT: PASS (zero un-allowlisted feature-sense occurrences)');
      } else {
        console.log('RESULT: FAIL');
      }
    }
    return result.findings.length === 0 ? 0 : 1;
  } catch (e) {
    console.error('ERROR: ' + e.message);
    return 2;
  }
}

process.exit(main());
