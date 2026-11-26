/**
 * `fredo-app` — the publishing kit's two verbs (Spec #3145, ST-2).
 *
 *   fredo-app check <dir> [--fredo <version>] [--specifiers] [--json]
 *   fredo-app pack  <dir> --out <file> [--json]
 *
 * Both are plain Node: run them as
 *   node <kit>/fredo-authoring/bin/fredo-app.mjs <verb> …
 * — there is no registry install and no dependency beyond Node's built-ins
 * (NFR-3), so the kit resolves on a machine with no Fredo checkout.
 *
 * `check` reports the SHIPPED refusal vocabulary — the same 22 wire strings the
 * installer emits — and names the exact dotted field, so the refusal an author
 * meets at `check` time is the one the product would give them. `pack`
 * validates first (a package that would be refused is never emitted) and then
 * writes a deterministic archive; two packs of the same directory have the same
 * sha256.
 *
 * Exit status: 0 clean, 1 violations/refused, 2 usage.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ArchiveRefused, buildArchive } from '../lib/pack.mjs';
import { scanSpecifiers } from '../lib/specifiers.mjs';
import { checkPackage, refusalCodes } from '../lib/validate.mjs';

const HELP = `fredo-app — check and pack a Fredo application package.

Usage:
  node <kit>/fredo-authoring/bin/fredo-app.mjs check <dir> [--fredo <version>] [--specifiers] [--json]
  node <kit>/fredo-authoring/bin/fredo-app.mjs pack  <dir> --out <file> [--json]
  node <kit>/fredo-authoring/bin/fredo-app.mjs --help

Verbs:
  check   validate <dir>'s fredo-app.json (and the files its entry names) against the
          published schema; print every violation as { code, field?, detail } and exit
          non-zero if there is one. --fredo <version> adds the engines.fredo range check
          against that Fredo version; without it the range check is reported as not
          performed. --specifiers additionally confirms the package is self-contained:
          every module specifier must be a relative path resolving to a file in the
          package, and no host-internal shape may appear. Each specifier problem is
          printed as specifier_not_relative / specifier_unresolved /
          specifier_host_internal, and a non-empty set makes check exit non-zero.
  pack    validate, then write a deterministic .zip to --out (stored entries, a fixed
          1980-01-01 DOS timestamp, a fixed entry order) and print its sha256. Pack the
          same directory twice and compare the two digests.

The refusal codes are the installer's own vocabulary (${refusalCodes().length} codes), so a
violation the checker reports is the refusal the product would give.`;

/** Parse `--flag value` pairs plus the verb and its positional. */
function parseArgs(argv) {
  const options = { verb: null, target: null, out: null, fredo: null, json: false, specifiers: false, help: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--specifiers') options.specifiers = true;
    else if (arg === '--out' || arg === '--fredo') {
      const value = argv[++index];
      if (!value) throw new UsageError(`${arg} needs a value`);
      if (arg === '--out') options.out = value;
      else options.fredo = value;
    } else if (arg.startsWith('--')) throw new UsageError(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 0) options.verb = positional[0];
  if (positional.length > 1) options.target = positional[1];
  if (positional.length > 2) throw new UsageError(`unexpected argument: ${positional[2]}`);
  return options;
}

class UsageError extends Error {}

function printViolations(violations) {
  for (const violation of violations) {
    const field = violation.field === undefined ? '' : ` field=${violation.field}`;
    console.error(`${violation.code}:${field} ${violation.detail}`);
  }
}

function runCheck(options) {
  const target = path.resolve(process.cwd(), options.target);
  const { violations, notChecked } = checkPackage(target, {
    fredoVersion: options.fredo ?? undefined,
  });

  // The specifier scan is an ADDITIONAL mode: without --specifiers the output and
  // exit code are exactly what they were before (no new key, no new failure).
  const specifiers = options.specifiers ? scanSpecifiers(target) : null;

  if (options.json) {
    const payload = {
      valid: violations.length === 0,
      violations,
      notChecked,
    };
    if (specifiers !== null) payload.specifiers = specifiers;
    console.log(JSON.stringify(payload, null, 2));
  } else {
    if (violations.length === 0) {
      console.log(`CHECK OK ${target}`);
    } else {
      printViolations(violations);
    }
    for (const note of notChecked) console.log(`not checked: ${note}`);
    if (specifiers !== null) {
      if (specifiers.ok) {
        console.log(`specifiers OK: ${specifiers.imports.length} import(s), 0 problems`);
      } else {
        for (const problem of specifiers.problems) {
          console.error(`${problem.problem}: file=${problem.file} specifier=${problem.specifier}`);
        }
      }
    }
  }

  const specifierProblems = specifiers === null ? 0 : specifiers.problems.length;
  return violations.length === 0 && specifierProblems === 0 ? 0 : 1;
}

function runPack(options) {
  if (options.out === null) throw new UsageError('pack needs --out <file>');
  const target = path.resolve(process.cwd(), options.target);
  const out = path.resolve(process.cwd(), options.out);

  const { violations, notChecked, manifest } = checkPackage(target, {
    fredoVersion: options.fredo ?? undefined,
  });
  if (violations.length > 0 || manifest === null) {
    if (options.json) {
      console.log(JSON.stringify({ packed: false, violations, notChecked }, null, 2));
    } else {
      console.error('REFUSED: the package would be refused, so nothing was written.');
      printViolations(violations);
    }
    return 1;
  }

  let built;
  try {
    built = buildArchive(target, manifest.entry);
  } catch (error) {
    if (error instanceof ArchiveRefused) {
      const violation = error.violation;
      if (options.json) {
        console.log(JSON.stringify({ packed: false, violations: [violation], notChecked }, null, 2));
      } else {
        console.error('REFUSED: the package would be refused, so nothing was written.');
        printViolations([violation]);
      }
      return 1;
    }
    throw error;
  }

  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, built.archive);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          packed: true,
          out,
          bytes: built.archive.length,
          entries: built.entries.length,
          sha256: built.sha256,
          names: built.names,
          notChecked,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `PACKED out=${out} bytes=${built.archive.length} entries=${built.entries.length} sha256=${built.sha256}`,
    );
    for (const note of notChecked) console.log(`not checked: ${note}`);
  }
  return 0;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    console.error('');
    console.error(HELP);
    process.exitCode = 2;
    return;
  }
  if (options.help || options.verb === null) {
    console.log(HELP);
    process.exitCode = options.verb === null && !options.help ? 2 : 0;
    return;
  }
  if (options.verb !== 'check' && options.verb !== 'pack') {
    console.error(`ERROR: unknown verb "${options.verb}" — the verbs are exactly: check, pack`);
    process.exitCode = 2;
    return;
  }
  if (options.target === null) {
    console.error(`ERROR: ${options.verb} needs a package directory`);
    process.exitCode = 2;
    return;
  }

  try {
    process.exitCode = options.verb === 'check' ? runCheck(options) : runPack(options);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`ERROR: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
