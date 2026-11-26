/**
 * `@fredo/authoring` — the manifest validator (Spec #3145, ST-2).
 *
 * ONE machine-readable schema (`schema/fredo-app.schema.json`, generated from the
 * Rust parser's own constants by `manifest.rs`'s drift test) and ONE validator.
 * There is no hand-written third copy of the manifest shape: every key set,
 * length cap, pattern, const and enum below is read from the schema, which is
 * read from the parser.
 *
 * What the schema CANNOT express is done in code here, in the PARSER's own
 * order (`applications/installed_apps/manifest.rs::parse_manifest`): the
 * `engines.fredo` semver-range rules, the `entry.*` path rules, the declared
 * table model, and `entry_missing` against the files on disk. The kit states
 * which of those it could not perform when `--fredo <version>` is absent.
 *
 * The kit is an AUTHORING-TIME description, never an enforcement input (NFR-2):
 * Fredo never reads it at install or load, so a lenient (or bypassed) kit cannot
 * widen what a package may do.
 *
 * Node built-ins only.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SCHEMA_URL = new URL('../schema/fredo-app.schema.json', import.meta.url);

/** The manifest's file name at a package root (`PACKAGE_MANIFEST_FILENAME`). */
export const MANIFEST_FILENAME = 'fredo-app.json';

/** A path segment a package may never claim (`RESERVED_PATH_SEGMENT`). */
export const RESERVED_PATH_SEGMENT = '__fredo';

/** The frozen refusal vocabulary — read from the schema, never re-typed here. */
let cachedSchema = null;

/** @returns {any} the generated schema (cached). */
export function loadSchema() {
  if (cachedSchema === null) {
    cachedSchema = JSON.parse(readFileSync(SCHEMA_URL, 'utf8'));
  }
  return cachedSchema;
}

/** The 22 frozen refusal wire strings, in the parser's documented order. */
export function refusalCodes() {
  return [...loadSchema()['x-fredo-refusal-codes']];
}

/** Every top-level manifest key the schema defines. */
export function topLevelKeys() {
  return Object.keys(schemaNode().properties);
}

function schemaNode() {
  return loadSchema();
}

/** Resolve a local `$ref` (`#/$defs/…`) against the schema. */
function resolveRef(node) {
  if (node === null || typeof node !== 'object' || typeof node.$ref !== 'string') return node;
  let current = schemaNode();
  for (const segment of node.$ref.replace(/^#\//, '').split('/')) {
    current = current?.[segment];
  }
  if (current === undefined) {
    throw new Error(`the manifest schema has an unresolvable $ref: ${node.$ref}`);
  }
  return current;
}

/* ==========================================================================
 * SemVer 2.0.0 version + range (the rules JSON Schema cannot express)
 * ========================================================================== */

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Parse a SemVer 2.0.0 version, or null. */
export function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const match = VERSION_RE.exec(text);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Parse a semver RANGE the way the parser accepts one (`semver::VersionReq`):
 * `*`, or comma/space separated comparators with `>=`, `>`, `<=`, `<`, `=`, `^`,
 * `~`. Returns null for a range the parser would refuse.
 */
export function parseRange(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (trimmed === '*' || trimmed === 'x' || trimmed === 'X') return [];
  const parts = trimmed.split(/\s*,\s*|\s+/).filter((part) => part.length > 0);
  const comparators = [];
  for (const part of parts) {
    if (part === '*' || part === 'x' || part === 'X') continue;
    const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(part);
    if (match === null) return null;
    const operator = match[1] ?? '=';
    const raw = match[2];
    if (!/^[0-9]+(\.[0-9]+)?(\.[0-9]+)?(-[0-9A-Za-z.-]+)?$/.test(raw)) return null;
    const numbers = raw.split('-')[0].split('.').map((value) => Number(value));
    const prerelease = raw.includes('-') ? raw.slice(raw.indexOf('-') + 1).split('.') : [];
    if (numbers.some((value) => !Number.isInteger(value) || value < 0)) return null;
    const version = {
      major: numbers[0],
      minor: numbers[1] ?? 0,
      patch: numbers[2] ?? 0,
      prerelease,
    };
    comparators.push({ operator, version, precision: numbers.length });
  }
  return comparators;
}

/** Does `version` satisfy the parsed `range`? */
export function satisfies(version, comparators) {
  if (comparators.length === 0) return true;
  return comparators.every(({ operator, version: bound, precision }) => {
    const comparison = compareVersions(version, bound);
    switch (operator) {
      case '>=':
        return comparison >= 0;
      case '>':
        return comparison > 0;
      case '<=':
        return comparison <= 0;
      case '<':
        return comparison < 0;
      case '=':
        if (precision >= 3) return comparison === 0;
        if (precision === 2) {
          return version.major === bound.major && version.minor === bound.minor;
        }
        return version.major === bound.major;
      case '^': {
        if (comparison < 0) return false;
        if (bound.major > 0) return version.major === bound.major;
        if (bound.minor > 0) {
          return version.major === 0 && version.minor === bound.minor;
        }
        return version.major === 0 && version.minor === 0 && version.patch === bound.patch;
      }
      case '~': {
        if (comparison < 0) return false;
        if (precision <= 1) return version.major === bound.major;
        return version.major === bound.major && version.minor === bound.minor;
      }
      default:
        return false;
    }
  });
}

/* ==========================================================================
 * Rules read from the schema.
 * ========================================================================== */

function keyList(object) {
  return Object.keys(object);
}

function unknownKeyViolation(object, allowed, where, fieldPrefix) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allowedSet.has(key)) {
      return {
        code: 'manifest_unknown_field',
        field: `${fieldPrefix}${key}`,
        detail: `${where} carries the unknown field "${key}"; manifestVersion ${
          schemaNode().properties.manifestVersion.const
        } defines exactly ${JSON.stringify(allowed)}`,
      };
    }
  }
  return null;
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one entry path exactly as `manifest::validate_entry_path` does
 * (relative POSIX, no `..`, no absolute/drive/scheme form, required extension).
 */
export function entryPathViolation(value, extension) {
  if (value.length === 0) return 'must not be empty';
  if (value.includes('\\')) return "must use POSIX separators ('/'), not backslashes";
  if (value.startsWith('/')) return 'must be relative, not absolute';
  if (value.includes(':')) return 'must not carry a drive or scheme prefix';
  if (value.split('/').some((segment) => segment === '..')) return "must not contain a '..' component";
  if (value.split('/').some((segment) => segment === '')) return 'must not contain an empty path segment';
  if (!value.endsWith(extension)) {
    return extension === '.html' ? "must end with '.html'" : "must end with '.js'";
  }
  return null;
}

/* ==========================================================================
 * The ordered validator.
 * ========================================================================== */

/**
 * Validate a parsed manifest object against the schema + the parser's own
 * semantic rules, in the parser's order.
 *
 * @param {unknown} manifest
 * @param {{ fredoVersion?: string }} [options]
 * @returns {{ code: string, field?: string, detail: string }[]} the FIRST failing rule only
 *   — the parser fails fast, and so does this, so the kit and the product agree.
 */
export function validateManifest(manifest, options = {}) {
  const schema = schemaNode();
  const top = schema.properties;
  const extensions = schema['x-fredo-entry-extensions'];

  if (!isPlainObject(manifest)) {
    return [
      {
        code: 'manifest_malformed',
        detail: 'fredo-app.json must contain a JSON object',
      },
    ];
  }

  const unknownTop = unknownKeyViolation(manifest, keyList(top), 'fredo-app.json', '');
  if (unknownTop !== null) return [unknownTop];

  // manifestVersion
  const rawVersion = manifest.manifestVersion;
  if (rawVersion === undefined) {
    return [
      { code: 'manifest_invalid_field', field: 'manifestVersion', detail: 'manifestVersion is required' },
    ];
  }
  if (typeof rawVersion !== 'number') {
    return [
      {
        code: 'manifest_invalid_field',
        field: 'manifestVersion',
        detail: `manifestVersion must be a number (found ${rawVersion})`,
      },
    ];
  }
  if (!Number.isInteger(rawVersion) || rawVersion < 0) {
    return [
      {
        code: 'manifest_invalid_field',
        field: 'manifestVersion',
        detail: `manifestVersion must be a non-negative integer (found ${rawVersion})`,
      },
    ];
  }
  if (rawVersion !== top.manifestVersion.const) {
    return [
      {
        code: 'unsupported_manifest_version',
        field: 'manifestVersion',
        detail: `manifestVersion ${rawVersion} is not supported; this Fredo reads manifestVersion ${top.manifestVersion.const}`,
      },
    ];
  }

  // id
  if (typeof manifest.id !== 'string') {
    return [
      {
        code: 'manifest_invalid_field',
        field: 'id',
        detail: manifest.id === undefined ? 'id is required' : 'id must be a string',
      },
    ];
  }
  const idPattern = new RegExp(top.id.pattern);
  if (!idPattern.test(manifest.id) || manifest.id.length > top.id.maxLength) {
    return [
      {
        code: 'id_invalid',
        field: 'id',
        detail: `id "${manifest.id}" must match ${top.id.pattern} and be at most ${top.id.maxLength} characters`,
      },
    ];
  }
  if ((top.id.not?.enum ?? []).includes(manifest.id)) {
    return [
      {
        code: 'id_reserved',
        field: 'id',
        detail: `"${manifest.id}" is a built-in Fredo application id and cannot be installed`,
      },
    ];
  }

  // displayName
  if (typeof manifest.displayName !== 'string') {
    return [
      {
        code: 'manifest_invalid_field',
        field: 'displayName',
        detail: manifest.displayName === undefined ? 'displayName is required' : 'displayName must be a string',
      },
    ];
  }
  const displayNameChars = [...manifest.displayName].length;
  if (displayNameChars < top.displayName.minLength || displayNameChars > top.displayName.maxLength) {
    return [
      {
        code: 'manifest_invalid_field',
        field: 'displayName',
        detail: `displayName must be 1..${top.displayName.maxLength} characters (found ${displayNameChars})`,
      },
    ];
  }

  // version
  if (typeof manifest.version !== 'string') {
    return [
      {
        code: 'manifest_invalid_field',
        field: 'version',
        detail: manifest.version === undefined ? 'version is required' : 'version must be a string',
      },
    ];
  }
  if (manifest.version.startsWith('v') || new RegExp(top.version.pattern).test(manifest.version) === false) {
    return [
      {
        code: 'version_invalid',
        field: 'version',
        detail: `version "${manifest.version}" must be SemVer 2.0.0 with no "v" prefix`,
      },
    ];
  }

  // engines
  if (!isPlainObject(manifest.engines)) {
    return [
      {
        code: 'manifest_invalid_field',
        field: 'engines',
        detail:
          manifest.engines === undefined
            ? 'engines is required'
            : 'engines must be an object with a single "fredo" string',
      },
    ];
  }
  const enginesKeys = keyList(schema.$defs.engines.properties);
  const unknownEngines = unknownKeyViolation(manifest.engines, enginesKeys, 'engines', '');
  if (unknownEngines !== null) return [unknownEngines];
  if (typeof manifest.engines.fredo !== 'string') {
    return [
      {
        code: 'manifest_invalid_field',
        field: 'engines.fredo',
        detail: manifest.engines.fredo === undefined ? 'fredo is required' : 'fredo must be a string',
      },
    ];
  }

  // entry
  if (!isPlainObject(manifest.entry)) {
    return [
      {
        code: 'manifest_invalid_field',
        field: 'entry',
        detail:
          manifest.entry === undefined
            ? 'entry is required'
            : 'entry must be an object with "document" and "module" strings',
      },
    ];
  }
  const entryKeys = keyList(schema.$defs.entry.properties);
  const unknownEntry = unknownKeyViolation(manifest.entry, entryKeys, 'entry', '');
  if (unknownEntry !== null) return [unknownEntry];
  for (const field of ['document', 'module']) {
    if (typeof manifest.entry[field] !== 'string') {
      return [
        {
          code: 'manifest_invalid_field',
          field: `entry.${field}`,
          detail: manifest.entry[field] === undefined ? `${field} is required` : `${field} must be a string`,
        },
      ];
    }
    const reason = entryPathViolation(manifest.entry[field], extensions[field]);
    if (reason !== null) {
      return [
        {
          code: 'entry_invalid',
          field: `entry.${field}`,
          detail: `entry.${field} "${manifest.entry[field]}" ${reason}`,
        },
      ];
    }
  }

  // capabilities
  if (manifest.capabilities !== undefined && manifest.capabilities !== null) {
    const violation = validateCapabilities(manifest.capabilities, schema);
    if (violation !== null) return [violation];
  }

  // description (an explicit null is treated as absent, like the parser)
  if (manifest.description !== undefined && manifest.description !== null) {
    if (typeof manifest.description !== 'string') {
      return [
        {
          code: 'manifest_invalid_field',
          field: 'description',
          detail: 'description must be a string when present',
        },
      ];
    }
    const chars = [...manifest.description].length;
    if (chars > top.description.maxLength) {
      return [
        {
          code: 'manifest_invalid_field',
          field: 'description',
          detail: `description must be at most ${top.description.maxLength} characters (found ${chars})`,
        },
      ];
    }
  }

  // engines.fredo range — LAST, so a bad field reports first (the parser's order).
  return validateEnginesRange(manifest.engines.fredo, options.fredoVersion);
}

function validateCapabilities(capabilities, schema) {
  if (!isPlainObject(capabilities)) {
    return {
      code: 'manifest_invalid_field',
      field: 'capabilities',
      detail: 'capabilities must be an object',
    };
  }
  const definition = schema.$defs.capabilities;
  const unknown = unknownKeyViolation(capabilities, keyList(definition.properties), 'capabilities', 'capabilities.');
  if (unknown !== null) return unknown;

  if (capabilities.version === undefined) {
    return {
      code: 'manifest_invalid_field',
      field: 'capabilities.version',
      detail: 'capabilities.version is required',
    };
  }
  if (typeof capabilities.version !== 'number' || !Number.isInteger(capabilities.version)) {
    return {
      code: 'manifest_invalid_field',
      field: 'capabilities.version',
      detail: `capabilities.version must be a non-negative integer (found ${capabilities.version})`,
    };
  }
  if (capabilities.version !== definition.properties.version.const) {
    return {
      code: 'manifest_invalid_field',
      field: 'capabilities.version',
      detail:
        `capabilities.version ${capabilities.version} is not supported; this Fredo implements ` +
        `capabilities.version ${definition.properties.version.const}. The capability contract is ` +
        'additive within a major, so a different major cannot be read safely',
    };
  }

  if (capabilities.data !== undefined && capabilities.data !== null) {
    const data = capabilities.data;
    if (!isPlainObject(data)) {
      return {
        code: 'manifest_invalid_field',
        field: 'capabilities.data',
        detail: 'capabilities.data must be an object with a "tables" array',
      };
    }
    const dataDefinition = definition.properties.data;
    const unknownData = unknownKeyViolation(
      data,
      keyList(dataDefinition.properties),
      'capabilities.data',
      'capabilities.data.',
    );
    if (unknownData !== null) return unknownData;
    if (data.tables === undefined) {
      return {
        code: 'manifest_invalid_field',
        field: 'capabilities.data.tables',
        detail:
          'capabilities.data.tables is required when capabilities.data is present; declare an ' +
          'empty list when the application writes to no tables',
      };
    }
    if (!Array.isArray(data.tables)) {
      return {
        code: 'manifest_invalid_field',
        field: 'capabilities.data.tables',
        detail: 'capabilities.data.tables must be an array of table declarations',
      };
    }
    for (const [index, table] of data.tables.entries()) {
      const violation = validateTable(
        table,
        index,
        resolveRef(dataDefinition.properties.tables.items),
      );
      if (violation !== null) return violation;
    }
  }

  if (capabilities.highRisk !== undefined && capabilities.highRisk !== null) {
    const highRisk = capabilities.highRisk;
    if (!Array.isArray(highRisk)) {
      return {
        code: 'manifest_invalid_field',
        field: 'capabilities.highRisk',
        detail: 'capabilities.highRisk must be an array of capability ids',
      };
    }
    const allowed = definition.properties.highRisk.items.enum;
    const seen = new Set();
    for (const [index, entry] of highRisk.entries()) {
      const field = `capabilities.highRisk[${index}]`;
      if (typeof entry !== 'string') {
        return {
          code: 'manifest_invalid_field',
          field,
          detail: `${field} must be a capability id string (found ${JSON.stringify(entry)})`,
        };
      }
      if (!allowed.includes(entry)) {
        return {
          code: 'manifest_invalid_field',
          field,
          detail: `"${entry}" is not a high-risk capability this Fredo can ask you to consent to; the declared ids are ${JSON.stringify(allowed)}`,
        };
      }
      if (seen.has(entry)) {
        return {
          code: 'manifest_invalid_field',
          field,
          detail: `"${entry}" is declared more than once`,
        };
      }
      seen.add(entry);
    }
  }

  return null;
}

function validateTable(table, index, tableSchema) {
  const path_ = `capabilities.data.tables[${index}]`;
  if (!isPlainObject(table)) {
    return { code: 'manifest_invalid_field', field: path_, detail: `${path_} must be an object` };
  }
  // `source` is refused FIRST, by name: it reads a canonical table.
  if (Object.prototype.hasOwnProperty.call(table, 'source')) {
    return {
      code: 'manifest_invalid_field',
      field: `${path_}.source`,
      detail:
        `${path_}.source is refused: a declared source projection reads Fredo's canonical tables ` +
        '(your own sessions and tool activity), which an installed application may never declare',
    };
  }
  const unknown = unknownKeyViolation(table, keyList(tableSchema.properties), path_, `${path_}.`);
  if (unknown !== null) return unknown;

  const columnSchema = resolveRef(tableSchema.properties.columns.items);
  const typeEnum = columnSchema.properties.type.enum;
  const ownerEnum = columnSchema.properties.owner.enum;

  if (typeof table.name !== 'string' || table.name.length === 0) {
    return {
      code: 'manifest_invalid_field',
      field: path_,
      detail: `${path_} is not a valid table declaration: \`name\` is required`,
    };
  }
  if (typeof table.primaryKey !== 'string' && !Array.isArray(table.primaryKey)) {
    return {
      code: 'manifest_invalid_field',
      field: path_,
      detail: `${path_} is not a valid table declaration: \`primaryKey\` must be an array of column names`,
    };
  }
  const primaryKey = Array.isArray(table.primaryKey) ? table.primaryKey : [table.primaryKey];
  if (!Array.isArray(table.columns) || table.columns.length === 0) {
    return {
      code: 'manifest_invalid_field',
      field: path_,
      detail: `${path_} is not a valid table declaration: \`columns\` must be a non-empty array`,
    };
  }
  const columnNames = new Set();
  for (const column of table.columns) {
    if (!isPlainObject(column) || typeof column.name !== 'string' || column.name.length === 0) {
      return {
        code: 'manifest_invalid_field',
        field: path_,
        detail: `${path_} is not a valid table declaration: every column needs a \`name\``,
      };
    }
    if (columnNames.has(column.name)) {
      return {
        code: 'manifest_invalid_field',
        field: path_,
        detail: `${path_} is not a valid table declaration: column "${column.name}" is declared more than once`,
      };
    }
    columnNames.add(column.name);
    if (!typeEnum.includes(column.type)) {
      return {
        code: 'manifest_invalid_field',
        field: path_,
        detail: `${path_} is not a valid table declaration: column "${column.name}" has an unknown type ${JSON.stringify(column.type)} (expected one of ${JSON.stringify(typeEnum)})`,
      };
    }
    if (!ownerEnum.includes(column.owner)) {
      return {
        code: 'manifest_invalid_field',
        field: path_,
        detail: `${path_} is not a valid table declaration: column "${column.name}" has an unknown owner ${JSON.stringify(column.owner)} (expected one of ${JSON.stringify(ownerEnum)})`,
      };
    }
  }
  for (const key of primaryKey) {
    if (typeof key !== 'string' || !columnNames.has(key)) {
      return {
        code: 'manifest_invalid_field',
        field: path_,
        detail: `${path_} is not a valid table declaration: primary key "${key}" names no declared column`,
      };
    }
  }
  return null;
}

function validateEnginesRange(range, fredoVersion) {
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') {
    return [
      {
        code: 'engines_range_invalid',
        field: 'engines.fredo',
        detail: `engines.fredo "${range}" must be a semver range such as ">=0.1.0"; "*" and an empty string are refused`,
      },
    ];
  }
  const comparators = parseRange(trimmed);
  if (comparators === null) {
    return [
      {
        code: 'engines_range_invalid',
        field: 'engines.fredo',
        detail: `engines.fredo "${range}" is not a valid semver range`,
      },
    ];
  }
  if (fredoVersion === undefined || fredoVersion === null) {
    return [];
  }
  const host = parseVersion(String(fredoVersion).trim());
  if (host === null) {
    return [
      {
        code: 'host_incompatible',
        detail: `this build's own version "${fredoVersion}" is not parseable as SemVer`,
      },
    ];
  }
  if (!satisfies(host, comparators)) {
    return [
      {
        code: 'host_incompatible',
        field: 'engines.fredo',
        detail: `this package requires Fredo "${range}", but the running Fredo is ${fredoVersion}`,
      },
    ];
  }
  return [];
}

/* ==========================================================================
 * Whole-directory check (the `check` verb's body).
 * ========================================================================== */

/** Every file under `directory`, as POSIX-relative paths (sorted). */
export function listFiles(directory) {
  const files = [];
  const walk = (absolute, relative) => {
    const entries = readdirSync(absolute, { withFileTypes: true })
      .slice()
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        files.push(`${childRelative}/`);
        walk(childAbsolute, childRelative);
      } else if (entry.isFile()) {
        files.push(childRelative);
      }
    }
  };
  walk(directory, '');
  return files;
}

/**
 * Check an application directory: manifest rules + the files the entry names.
 *
 * @param {string} directory
 * @param {{ fredoVersion?: string }} [options]
 * @returns {{ violations: object[], notChecked: string[], manifest: object | null }}
 */
export function checkPackage(directory, options = {}) {
  const notChecked = [];
  const violations = [];
  const files = listFiles(directory);

  for (const file of files) {
    if (file.replace(/\/$/, '').split('/').includes(RESERVED_PATH_SEGMENT)) {
      return {
        violations: [
          {
            code: 'reserved_path',
            field: file.replace(/\/$/, ''),
            detail: `"${file.replace(/\/$/, '')}" claims the host-reserved "${RESERVED_PATH_SEGMENT}/" segment`,
          },
        ],
        notChecked,
        manifest: null,
      };
    }
  }

  const manifestFile = path.join(directory, MANIFEST_FILENAME);
  let bytes;
  try {
    if (!statSync(manifestFile).isFile()) throw new Error('not a file');
    bytes = readFileSync(manifestFile, 'utf8');
  } catch {
    return {
      violations: [
        {
          code: 'no_manifest',
          detail: `${MANIFEST_FILENAME} is missing from the package root`,
        },
      ],
      notChecked,
      manifest: null,
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(bytes);
  } catch (error) {
    return {
      violations: [
        {
          code: 'manifest_malformed',
          detail: `${MANIFEST_FILENAME} is not valid JSON: ${error.message}`,
        },
      ],
      notChecked,
      manifest: null,
    };
  }

  const first = validateManifest(manifest, options);
  if (first.length > 0) {
    return { violations: first, notChecked, manifest: null };
  }

  if (options.fredoVersion === undefined || options.fredoVersion === null) {
    notChecked.push(
      'host_incompatible (engines.fredo against the running Fredo version): pass --fredo <version> to check it',
    );
  }

  const presentFiles = new Set(files.filter((file) => !file.endsWith('/')));
  for (const field of ['document', 'module']) {
    const entryPath = manifest.entry[field];
    if (!presentFiles.has(entryPath)) {
      violations.push({
        code: 'entry_missing',
        field: `entry.${field}`,
        detail: `entry.${field} names "${entryPath}", which is not in the package`,
      });
    }
  }

  return { violations, notChecked, manifest };
}
