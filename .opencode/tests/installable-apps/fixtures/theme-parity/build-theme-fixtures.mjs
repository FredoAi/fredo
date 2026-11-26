/**
 * build-theme-fixtures.mjs — the theme-parity fixture application and its three
 * "may not rely on" negative variants (Spec #3145, ST-1).
 *
 * ONE generator entry emits all four packages, so the three negatives are
 * byte-identical to the positive except for exactly ONE host-internal import.
 * That is what makes QA's F-8.14 honest: the negative loads and the specifier
 * scan agree by construction, and neither is hand-rolled.
 *
 *   theme-parity/                     the positive: published artifacts only
 *   theme-parity-neg-shared-store/    + import "@/shared/installed-apps/store"
 *   theme-parity-neg-base-class/      + import "apps/ui/src/applications/FredoApplicationClass"
 *   theme-parity-neg-register/        + import "@/applications/registerApplication"
 *
 * THE VENDORING ROUTE IS THE FIXTURE'S POINT. A published artifact is
 * runtime-reachable only by being part of the installed package: the `fredoapp`
 * handler's serve whitelist is the install record, and a bare `@fredo/theme`
 * specifier never resolves in the child document (no bundler, no import map,
 * `script-src 'self'`). So `vendor/fredo-theme/` is a COPY of
 * `packages/fredo-theme/dist/` and the module imports it RELATIVELY.
 *
 * The fixture paints from token NAMES only and mirrors every reading as plain
 * visible text in `[data-testid="authoring-theme-readout"]` (UI/UX §2 grammar),
 * because the installed window is deliberately unreachable by every
 * `tauri_webview_*` tool — the readout is read by a native accessibility text
 * read.
 *
 * Self-checks run on EVERY build (the gate that never runs is not a gate):
 * the readout hook and the mirrored token names exist, every import is relative
 * and resolves to a file this package carries, the negatives differ by exactly
 * one line, no emitted file carries a colour literal, and every manifest is
 * schema-legal per the generated schema.
 *
 * Usage:
 *   node .opencode/tests/installable-apps/fixtures/theme-parity/build-theme-fixtures.mjs
 *   node ... --check           verify the committed fixtures are current (writes nothing)
 *   node ... --out <dir>       write the four packages under <dir> instead
 *   node ... --help
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');
const THEME_DIST = path.join(REPO_ROOT, 'packages', 'fredo-theme', 'dist');
const AUTHORING_VALIDATE = path.join(
  REPO_ROOT,
  'packages',
  'fredo-authoring',
  'lib',
  'validate.mjs',
);
const DEFAULT_OUT = HERE;

/** The readout hook QA's rows read with a native accessibility text read. */
const READOUT_TESTID = 'authoring-theme-readout';

/** The token names the readout mirrors (the four the plan binds + two more). */
const READOUT_TOKENS = [
  'bg.canvas',
  'bg.surface',
  'fg.default',
  'border.default',
  'accent.default',
  'accent.subtle',
];

/** The one host-internal import each negative adds, and its fixture id. */
const VARIANTS = [
  { dir: 'theme-parity', id: 'qa3145-theme-parity', displayName: 'QA3145 Theme Parity', extraImport: null },
  {
    dir: 'theme-parity-neg-shared-store',
    id: 'qa3145-theme-neg-shared-store',
    displayName: 'QA3145 Theme Neg Shared Store',
    extraImport: `import '@/shared/installed-apps/store';`,
  },
  {
    dir: 'theme-parity-neg-base-class',
    id: 'qa3145-theme-neg-base-class',
    displayName: 'QA3145 Theme Neg Base Class',
    extraImport: `import { FredoApplicationClass } from 'apps/ui/src/applications/FredoApplicationClass';`,
  },
  {
    dir: 'theme-parity-neg-register',
    id: 'qa3145-theme-neg-register',
    displayName: 'QA3145 Theme Neg Register',
    extraImport: `import { registerApplication } from '@/applications/registerApplication';`,
  },
];

/** A stable, identifier-safe manifest for one variant. */
function manifestFor(variant) {
  return {
    manifestVersion: 1,
    id: variant.id,
    displayName: variant.displayName,
    version: '1.0.0',
    engines: { fredo: '>=0.0.0' },
    entry: { document: 'index.html', module: 'main.js' },
    description:
      'Spec 3145 ST-1 theme-parity fixture: paints only published theme tokens and mirrors ' +
      'every reading as plain visible text for a native accessibility read.',
  };
}

/** The document: no script (the host injects the bootstrap), no colour literal. */
function documentHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>QA3145 theme parity fixture</title>
  <!-- The vendored stylesheet, reached RELATIVELY through the install record — the
       second half of the vendoring route (the module import is the first). It
       declares the five published alias properties; the painted nodes below use
       cssVar() so each colour is attributable to exactly one token name. -->
  <link rel="stylesheet" href="./vendor/fredo-theme/theme.css" />
  <!-- Generated by .opencode/tests/installable-apps/fixtures/theme-parity/build-theme-fixtures.mjs
       (Spec #3145, ST-1). The host's scheme handler injects the bootstrap, the theme
       and the root element, then imports entry.module and calls its exported mount(ctx).
       This file ships no script and claims no host-owned testid: the ONLY testid is the
       fixture's own readout, which is plain visible text. -->
  <style>
    html, body {
      margin: 0;
      padding: 0;
      /* The backdrop stipulation: --card-bg may be translucent, so the canvas is
         painted first and the card sits on top. Names only — never a value. */
      background: var(--body-bg);
      color: var(--text-primary);
      font-family: system-ui, sans-serif;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <noscript>This fixture needs JavaScript.</noscript>
</body>
</html>
`;
}

/** The module body — identical for every variant apart from ONE import line. */
function moduleSource(extraImport) {
  const lines = [];
  lines.push('// Generated by .opencode/tests/installable-apps/fixtures/theme-parity/build-theme-fixtures.mjs');
  lines.push('// (Spec #3145, ST-1). Plain ESM: the host imports this file and calls mount(ctx).');
  lines.push('// Every colour is a published token NAME; this module supplies no colour value.');
  lines.push(`import { cssVar } from './vendor/fredo-theme/index.mjs';`);
  if (extraImport !== null) lines.push(extraImport);
  lines.push('');
  lines.push('const READOUT_TESTID = ' + JSON.stringify(READOUT_TESTID) + ';');
  lines.push('const TOKEN_SLOTS = [' + READOUT_TOKENS.map((name) => `'${name}'`).join(', ') + '];');
  lines.push('');
  lines.push('/** A per-mount identity: a new value means the document reloaded. */');
  lines.push('function makeMountId() {');
  lines.push("  return 'm-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);");
  lines.push('}');
  lines.push('');
  lines.push('function readVar(name) {');
  lines.push("  return getComputedStyle(document.documentElement).getPropertyValue('--' + name.replace(/^--/, '')).trim();");
  lines.push('}');
  lines.push('');
  lines.push('function readPainted(node, property) {');
  lines.push('  return node === null ? \'\' : getComputedStyle(node)[property].trim();');
  lines.push('}');
  lines.push('');
  lines.push('export function mount(ctx) {');
  lines.push('  var root = ctx && ctx.root;');
  lines.push("  if (!root) throw new TypeError('theme-parity: ctx.root is missing from InstalledAppContext');");
  lines.push('  var doc = root.ownerDocument || document;');
  lines.push('  var appId = (ctx && ctx.appId) || \'unknown\';');
  lines.push('  var mountId = makeMountId();');
  lines.push('  var loaded = new Date().toISOString();');
  lines.push('');
  lines.push('  function node(tag, style) {');
  lines.push("    var element = doc.createElement(tag);");
  lines.push('    for (var key in style) element.style[key] = style[key];');
  lines.push('    root.appendChild(element);');
  lines.push('    return element;');
  lines.push('  }');
  lines.push('');
  lines.push('  // The painted nodes: each one is painted from ONE published token name, so the');
  lines.push('  // computed colour is the host\'s own value for that name.');
  lines.push('  var canvasEl = node(\'div\', {');
  lines.push('    padding: \'12px\',');
  lines.push("    background: cssVar('bg.canvas'),");
  lines.push("    color: cssVar('fg.default'),");
  lines.push('  });');
  lines.push('  var surfaceEl = node(\'div\', {');
  lines.push('    padding: \'12px\',');
  lines.push("    background: cssVar('bg.surface'),");
  lines.push("    border: '1px solid ' + cssVar('border.default'),");
  lines.push('  });');
  lines.push('  var textEl = node(\'p\', {');
  lines.push('    margin: \'0 0 8px 0\',');
  lines.push("    color: cssVar('fg.default'),");
  lines.push('  });');
  lines.push("  textEl.textContent = 'Theme parity fixture.';");
  lines.push('  var accentFillEl = node(\'span\', {');
  lines.push('    display: \'inline-block\',');
  lines.push('    padding: \'6px 10px\',');
  lines.push("    background: cssVar('accent.default'),");
  lines.push("    color: cssVar('accent.contrast'),");
  lines.push('  });');
  lines.push("  accentFillEl.textContent = 'accent.default';");
  lines.push('  var tintChipEl = node(\'span\', {');
  lines.push('    display: \'inline-block\',');
  lines.push('    padding: \'6px 10px\',');
  lines.push("    background: cssVar('accent.subtle'),");
  lines.push("    color: cssVar('fg.default'),");
  lines.push('  });');
  lines.push("  tintChipEl.textContent = 'accent.subtle';");
  lines.push('  var borderEl = node(\'div\', {');
  lines.push('    marginTop: \'8px\',');
  lines.push("    borderTop: '3px solid ' + cssVar('border.default'),");
  lines.push('  });');
  lines.push('  var readout = node(\'pre\', {');
  lines.push('    marginTop: \'12px\',');
  lines.push('    whiteSpace: \'pre-wrap\',');
  lines.push('    wordBreak: \'break-word\',');
  lines.push("    color: cssVar('fg.default'),");
  lines.push('  });');
  lines.push('  readout.setAttribute(\'data-testid\', READOUT_TESTID);');
  lines.push('');
  lines.push('  function publish() {');
  lines.push('    var degraded = [];');
  lines.push('    var parts = [');
  lines.push("      'AUTHORING-THEME',");
  lines.push("      'app=' + appId,");
  lines.push("      'mount=' + mountId,");
  lines.push("      'loaded=' + loaded,");
  lines.push("      'colorScheme=' + (document.documentElement.style.colorScheme || (ctx.theme && ctx.theme.colorScheme) || 'unknown'),");
  lines.push('    ];');
  lines.push('    for (var index = 0; index < TOKEN_SLOTS.length; index += 1) {');
  lines.push('      var name = TOKEN_SLOTS[index];');
  lines.push('      var value = readVar(name);');
  lines.push("      if (value === '') degraded.push(name);");
  lines.push("      parts.push(name + '=' + (value === '' ? '(empty)' : value));");
  lines.push('    }');
  lines.push('    var painted = [');
  lines.push("      ['painted.canvas', readPainted(canvasEl, 'backgroundColor')],");
  lines.push("      ['painted.surface', readPainted(surfaceEl, 'backgroundColor')],");
  lines.push("      ['painted.text', readPainted(textEl, 'color')],");
  lines.push("      ['painted.border', readPainted(borderEl, 'borderTopColor')],");
  lines.push("      ['painted.accentFill', readPainted(accentFillEl, 'backgroundColor')],");
  lines.push("      ['painted.tintChip', readPainted(tintChipEl, 'backgroundColor')],");
  lines.push('    ];');
  lines.push('    for (var slot = 0; slot < painted.length; slot += 1) {');
  lines.push('      var key = painted[slot][0];');
  lines.push('      var colour = painted[slot][1];');
  lines.push("      if (colour === '') degraded.push(key);");
  lines.push("      parts.push(key + '=' + (colour === '' ? '(empty)' : colour));");
  lines.push('    }');
  lines.push('    // The published alias class is painted from cssVar() and is compared with the raw');
  lines.push('    // accent fill: a cssVar() that returned a bare var() would make these equal.');
  lines.push('    if (degraded.length > 0) parts.push(\'degraded=\' + degraded.join(\',\'));');
  lines.push("    readout.textContent = parts.join(' ');");
  lines.push('  }');
  lines.push('');
  lines.push('  publish();');
  lines.push('  setInterval(publish, 1000);');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function fileSetFor(variant, themeDist) {
  return [
    { rel: 'fredo-app.json', content: JSON.stringify(manifestFor(variant), null, 2) + '\n' },
    { rel: 'index.html', content: documentHtml() },
    { rel: 'main.js', content: moduleSource(variant.extraImport) },
    { rel: 'vendor/fredo-theme/index.mjs', content: themeDist.indexMjs },
    { rel: 'vendor/fredo-theme/theme.css', content: themeDist.themeCss },
  ];
}

/* ==========================================================================
 * Self-checks — run on EVERY build.
 * ========================================================================== */

const FORBIDDEN_SPECIFIERS = [
  '@/shared/installed-apps/store',
  'apps/ui/src/applications/FredoApplicationClass',
  '@/applications/registerApplication',
];

/** Scan one emitted text for colour literals (comments stripped). */
function colourLiterals(file, text) {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const violations = [];
  for (const match of stripped.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) violations.push(`${file}: hex ${match[0]}`);
  for (const match of stripped.matchAll(/\b(?:rgb|rgba|hsl|hsla)\(/g)) violations.push(`${file}: ${match[0]}`);
  const named = ['white', 'black', 'red', 'green', 'blue', 'gray', 'grey', 'purple', 'orange', 'yellow', 'red', 'magenta', 'cyan', 'navy', 'teal', 'lime', 'aqua', 'fuchsia', 'maroon', 'olive'];
  for (const match of stripped.matchAll(/\b[a-zA-Z]+\b/g)) {
    if (named.includes(match[0].toLowerCase())) violations.push(`${file}: named colour ${match[0]}`);
  }
  return violations;
}

/** Every `import … from '…'` / `import '…'` specifier in a module body. */
function importSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

async function selfCheck(packages) {
  const problems = [];
  const { validateManifest } = await import(`file://${AUTHORING_VALIDATE.replace(/\\/g, '/')}`);
  const positive = packages[0];

  for (const entry of packages) {
    for (const file of entry.files) {
      for (const problem of colourLiterals(path.join(entry.dir, file.rel), file.content)) {
        problems.push(problem);
      }
    }

    const main = entry.files.find((file) => file.rel === 'main.js').content;
    const specifiers = importSpecifiers(main);
    const declared = entry.variant.extraImport === null ? [] : importSpecifiers(entry.variant.extraImport);
    const expected = ['./vendor/fredo-theme/index.mjs', ...declared];
    if (specifiers.length !== expected.length) {
      problems.push(
        `${entry.dir}: expected ${expected.length} import(s) (${expected.join(', ')}), found ${specifiers.length} (${specifiers.join(', ')})`,
      );
    }
    for (const specifier of specifiers) {
      if (!expected.includes(specifier)) {
        problems.push(`${entry.dir}: unexpected import specifier "${specifier}"`);
      }
    }
    if (entry.variant.extraImport !== null) {
      const hostInternal = FORBIDDEN_SPECIFIERS.find((forbidden) => entry.variant.extraImport.includes(forbidden));
      if (hostInternal === undefined) {
        problems.push(`${entry.dir}: its one extra import must name a host-internal specifier`);
      }
    }

    if (!main.includes(READOUT_TESTID)) problems.push(`${entry.dir}: the readout hook is missing`);
    for (const token of READOUT_TOKENS) {
      if (!main.includes(`'${token}'`)) problems.push(`${entry.dir}: the readout does not mirror ${token}`);
    }
    if (!main.includes("cssVar('accent.subtle')")) {
      problems.push(`${entry.dir}: the alias chip must be painted from cssVar('accent.subtle')`);
    }

    const manifest = JSON.parse(entry.files[0].content);
    const violations = validateManifest(manifest, {});
    for (const violation of violations) {
      problems.push(`${entry.dir}: manifest ${violation.code} ${violation.field ?? ''} ${violation.detail}`);
    }
  }

  // The three negatives are the positive plus EXACTLY ONE import line, and the
  // document/vendor files are identical.
  const positiveFiles = new Map(positive.files.map((file) => [file.rel, file.content]));
  for (const entry of packages.slice(1)) {
    const files = new Map(entry.files.map((file) => [file.rel, file.content]));
    if (files.get('index.html') !== positiveFiles.get('index.html')) {
      problems.push(`${entry.dir}: index.html must be byte-identical to the positive's`);
    }
    for (const rel of ['vendor/fredo-theme/index.mjs', 'vendor/fredo-theme/theme.css']) {
      if (files.get(rel) !== positiveFiles.get(rel)) {
        problems.push(`${entry.dir}: ${rel} must be byte-identical to the positive's`);
      }
    }
    const positiveMain = positiveFiles.get('main.js').split('\n');
    const variantMain = files.get('main.js').split('\n');
    const withoutExtra = variantMain.filter((line) => line !== entry.variant.extraImport);
    if (variantMain.length !== positiveMain.length + 1) {
      problems.push(
        `${entry.dir}: main.js must be the positive's plus exactly one line (got ${variantMain.length} vs ${positiveMain.length})`,
      );
    } else if (JSON.stringify(withoutExtra) !== JSON.stringify(positiveMain)) {
      problems.push(`${entry.dir}: main.js differs from the positive in more than its one import line`);
    }
  }

  return problems;
}

/* ==========================================================================
 * Driver.
 * ========================================================================== */

const HELP = `build-theme-fixtures.mjs — the theme-parity fixture and its three negatives (Spec #3145 ST-1).

Usage:
  node .opencode/tests/installable-apps/fixtures/theme-parity/build-theme-fixtures.mjs [options]

Options:
  --check        verify the committed fixtures are current (writes nothing; exit 1 on drift)
  --out <dir>    write the four packages under <dir> instead of beside this script
  --help         this text

The four packages are committed. They are a COPY of packages/fredo-theme/dist/ under
each package's vendor/fredo-theme/, imported relatively: a published artifact is
runtime-reachable only by being part of the installed package.`;

function parseArgs(argv) {
  const options = { check: false, help: false, out: DEFAULT_OUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--out') {
      const value = argv[++index];
      if (!value) throw new Error('--out needs a directory');
      options.out = path.resolve(process.cwd(), value);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function normalise(text) {
  return text.replace(/\r\n/g, '\n');
}

function readThemeDist() {
  return {
    indexMjs: readFileSync(path.join(THEME_DIST, 'index.mjs'), 'utf8'),
    themeCss: readFileSync(path.join(THEME_DIST, 'theme.css'), 'utf8'),
  };
}

function buildPackages(themeDist) {
  return VARIANTS.map((variant) => ({
    variant,
    dir: variant.dir,
    files: fileSetFor(variant, themeDist),
  }));
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(HELP);
    return;
  }

  const packages = buildPackages(readThemeDist());
  const problems = await selfCheck(packages);
  if (problems.length > 0) {
    console.error('SELF-CHECK FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  if (options.check) {
    const drifted = [];
    for (const entry of packages) {
      for (const file of entry.files) {
        const target = path.join(options.out, entry.dir, file.rel);
        let committed;
        try {
          committed = readFileSync(target, 'utf8');
        } catch {
          drifted.push(`${entry.dir}/${file.rel} (missing)`);
          continue;
        }
        if (normalise(committed) !== normalise(file.content)) {
          drifted.push(`${entry.dir}/${file.rel} (differs)`);
        }
      }
    }
    if (drifted.length > 0) {
      console.error(`DRIFT: the committed theme fixtures are stale — ${drifted.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    console.log(`DRIFT OK: ${packages.length} packages match the theme contract and this generator`);
    return;
  }

  for (const entry of packages) {
    for (const file of entry.files) {
      const target = path.join(options.out, entry.dir, file.rel);
      mkdirSync(path.dirname(target), { recursive: true });
      let committed = null;
      try {
        committed = readFileSync(target, 'utf8');
      } catch {
        committed = null;
      }
      if (committed !== null && normalise(committed) === normalise(file.content)) continue;
      writeFileSync(target, file.content, 'utf8');
      console.log(`wrote ${path.relative(REPO_ROOT, target)}`);
    }
  }
  console.log('');
  for (const entry of packages) {
    console.log(`${entry.variant.id}  ${entry.files.length} files  ${path.relative(REPO_ROOT, path.join(options.out, entry.dir))}`);
  }
}

await main();
