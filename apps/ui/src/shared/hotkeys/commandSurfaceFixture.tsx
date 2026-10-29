/**
 * Spec #3097 ST-6 — the DEV-ONLY command-surface fixture applications + panel.
 *
 * This module is the TESTER's lever for AC2–AC4 on a running webview. It ships
 * two stub `FredoApplicationClass` instances (`command-fixture-alpha` /
 * `command-fixture-beta`) and one panel component each, registered ONLY by the
 * DEV bridge (`commandSurfaceFixtureBridge.ts`) on `activate()` — never by
 * `allApplications.ts`'s `applications/<name>/index.ts` glob, so a production
 * build never sees them (`HotkeysProvider`'s DEV-gated dynamic import
 * tree-shakes both modules out).
 *
 * Binding fixture DOM contract (plan §7 / QA R-2.x–R-4.x):
 *   - root `command-fixture-root` with `data-command-operator="fixture-drag"`,
 *     `data-command-cursor="crosshair"` and decimal `data-command-runs` bumped
 *     inside EVERY command `run` (any trigger path);
 *   - `command-fixture-tool` — a visible control that pushes the `tool` mode;
 *   - `command-fixture-element` — a button whose `data-hotkey="x"` (ALPHA ONLY;
 *     QA R-2.1 requires beta to have no `x`) activation writes the
 *     distinguishable `element-x` value and bumps the run counter;
 *   - one plain text input for the in-app text-entry precedence leg;
 *   - `command-fixture-value` — the sink carrying the committed value plus
 *     `data-command-id` and `data-command-args-capture` (JSON of the args the
 *     handler received).
 *
 * `data-fredo-app-id` is supplied by the window frame (ST-5), NOT duplicated on
 * the panel root. The two apps bind `c` in `tool` to DIFFERENT command ids — the
 * AC2 same-key discriminator. State is module-scoped + `useSyncExternalStore`
 * (no React state churn, no listener, no persistence).
 *
 * UI hygiene: Chakra semantic tokens / CSS vars only (no hex/rgb/hsl, no
 * `var(--x)NN` alpha-append).
 */

import React, { useSyncExternalStore } from 'react';
import { Box, Button, chakra, Text } from '@chakra-ui/react';
import { LuAppWindow } from 'react-icons/lu';

import { getApplications, registerApplication } from '../../applications/applicationRegistry';
import { FredoApplicationClass } from '../classes';
import type { ApplicationCommandArgs, ApplicationCommandSurface } from './commandSurface';
import { pushMode } from './commandSurfaceStore';

// ── Binding ids / testids ────────────────────────────────────────────────────

export const FIXTURE_ALPHA_ID = 'command-fixture-alpha';
export const FIXTURE_BETA_ID = 'command-fixture-beta';
export const FIXTURE_APP_IDS: readonly string[] = [FIXTURE_ALPHA_ID, FIXTURE_BETA_ID];

export const FIXTURE_ROOT_TESTID = 'command-fixture-root';
export const FIXTURE_TOOL_TESTID = 'command-fixture-tool';
export const FIXTURE_ELEMENT_TESTID = 'command-fixture-element';
export const FIXTURE_VALUE_TESTID = 'command-fixture-value';

export const FIXTURE_OPERATOR = 'fixture-drag';
export const FIXTURE_CURSOR = 'crosshair';
export const FIXTURE_ELEMENT_KEY = 'x';
export const FIXTURE_ELEMENT_VALUE = 'element-x';

export const FIXTURE_BROWSE_MODE_ID = 'browse';
export const FIXTURE_TOOL_MODE_ID = 'tool';
export const FIXTURE_PIN_MODE_ID = 'pin';

export const FIXTURE_CAPTURE_COMMAND_ID = 'capture';
export const FIXTURE_BETA_CAPTURE_COMMAND_ID = 'capture-beta';
export const FIXTURE_TOOL_COMMAND_ID = 'open-tool';
export const FIXTURE_PIN_COMMAND_ID = 'open-pin';
export const FIXTURE_NOTE_COMMAND_ID = 'note';

// ── Module-scoped fixture state ──────────────────────────────────────────────

/** One fixture panel's observable state (stable identity between changes). */
export interface CommandFixtureSnapshot {
  readonly runs: number;
  readonly value: string;
  /** `JSON.stringify` of the args the capture handler received ('' before). */
  readonly argsCapture: string;
}

const EMPTY_FIXTURE_SNAPSHOT: CommandFixtureSnapshot = Object.freeze({
  runs: 0,
  value: '',
  argsCapture: '',
});

const fixtureStates = new Map<string, CommandFixtureSnapshot>();
const fixtureListeners = new Set<() => void>();

/** The panel's current state — a stable reference between real changes. */
export function getCommandFixtureSnapshot(appId: string): CommandFixtureSnapshot {
  return fixtureStates.get(appId) ?? EMPTY_FIXTURE_SNAPSHOT;
}

/** Subscribe to any fixture panel's state change (useSyncExternalStore). */
export function subscribeCommandFixture(listener: () => void): () => void {
  fixtureListeners.add(listener);
  return () => {
    fixtureListeners.delete(listener);
  };
}

function writeCommandFixtureState(appId: string, next: CommandFixtureSnapshot): void {
  fixtureStates.set(appId, Object.freeze(next));
  for (const listener of [...fixtureListeners]) listener();
}

/** Increment the run counter (EVERY command `run` path uses this). */
function bumpCommandFixtureRuns(
  appId: string,
  patch: Partial<CommandFixtureSnapshot> = {},
): void {
  const current = getCommandFixtureSnapshot(appId);
  writeCommandFixtureState(appId, { ...current, ...patch, runs: current.runs + 1 });
}

/** Drop one fixture's state (or every fixture's) — used by `deactivate()`. */
export function resetCommandFixtureState(appId?: string): void {
  if (appId === undefined) {
    if (fixtureStates.size === 0) return;
    fixtureStates.clear();
  } else if (!fixtureStates.delete(appId)) {
    return;
  }
  for (const listener of [...fixtureListeners]) listener();
}

// ── Command handlers ─────────────────────────────────────────────────────────

/** `capture` — stores `args?.value`, the args JSON, and bumps runs. */
function runCapture(appId: string, args?: ApplicationCommandArgs): void {
  bumpCommandFixtureRuns(appId, {
    value: args?.value ?? '',
    argsCapture: JSON.stringify(args ?? {}),
  });
}

/** `note` — sticky-mode receipt: run counter only. */
function runNote(appId: string): void {
  bumpCommandFixtureRuns(appId);
}

/** The `data-hotkey` element activation receipt (`.click()` never moves focus). */
function runElementActivation(appId: string): void {
  bumpCommandFixtureRuns(appId, { value: FIXTURE_ELEMENT_VALUE });
}

/** The capture command id for a fixture app (alpha `capture`, beta `capture-beta`). */
export function getFixtureCaptureCommandId(appId: string): string {
  return appId === FIXTURE_BETA_ID
    ? FIXTURE_BETA_CAPTURE_COMMAND_ID
    : FIXTURE_CAPTURE_COMMAND_ID;
}

/**
 * The fixture app's command surface. Both apps bind `c` in `tool` — to
 * DIFFERENT command ids (the AC2 same-key discriminator) — and share the
 * browse/tool/pin mode shape (sticky `pin`, non-sticky `tool`, root keymap
 * `t`/`p`).
 */
export function buildCommandFixtureSurface(appId: string): ApplicationCommandSurface {
  const captureId = getFixtureCaptureCommandId(appId);
  return {
    modes: [
      {
        id: FIXTURE_BROWSE_MODE_ID,
        label: 'Browse',
        parent: null,
        keymap: { t: FIXTURE_TOOL_COMMAND_ID, p: FIXTURE_PIN_COMMAND_ID },
      },
      {
        id: FIXTURE_TOOL_MODE_ID,
        label: 'Tool',
        parent: FIXTURE_BROWSE_MODE_ID,
        keymap: { c: captureId },
        cursor: FIXTURE_CURSOR,
        operator: FIXTURE_OPERATOR,
      },
      {
        id: FIXTURE_PIN_MODE_ID,
        label: 'Pin',
        parent: FIXTURE_BROWSE_MODE_ID,
        keymap: { n: FIXTURE_NOTE_COMMAND_ID },
        sticky: true,
      },
    ],
    commands: [
      {
        id: captureId,
        title: 'Capture value',
        prompt: { label: 'Capture value', placeholder: 'Type a value' },
        run: (args) => runCapture(appId, args),
      },
      {
        id: FIXTURE_TOOL_COMMAND_ID,
        title: 'Open tool',
        run: () => pushMode(appId, FIXTURE_TOOL_MODE_ID),
      },
      {
        id: FIXTURE_PIN_COMMAND_ID,
        title: 'Pin',
        run: () => pushMode(appId, FIXTURE_PIN_MODE_ID),
      },
      {
        id: FIXTURE_NOTE_COMMAND_ID,
        title: 'Add note',
        run: () => runNote(appId),
      },
    ],
  };
}

// ── The panel ────────────────────────────────────────────────────────────────

function CommandFixturePanel({ appId }: { readonly appId: string }): React.ReactElement {
  const snapshot = useSyncExternalStore(
    subscribeCommandFixture,
    () => getCommandFixtureSnapshot(appId),
    () => getCommandFixtureSnapshot(appId),
  );
  const captureId = getFixtureCaptureCommandId(appId);
  const isAlpha = appId === FIXTURE_ALPHA_ID;

  return (
    <Box
      data-testid={FIXTURE_ROOT_TESTID}
      data-command-app={appId}
      data-command-operator={FIXTURE_OPERATOR}
      data-command-cursor={FIXTURE_CURSOR}
      data-command-runs={String(snapshot.runs)}
      display="flex"
      flexDirection="column"
      gap="3"
      padding="4"
      height="100%"
      overflow="auto"
      bg="bg.surface"
      color="fg.default"
    >
      <Text fontSize="sm" fontWeight="medium" color="fg.default">
        {appId}
      </Text>

      <Box display="flex" alignItems="center" gap="2" flexWrap="wrap">
        <Button
          data-testid={FIXTURE_TOOL_TESTID}
          size="sm"
          variant="outline"
          onClick={() => pushMode(appId, FIXTURE_TOOL_MODE_ID)}
        >
          Enter tool mode
        </Button>
        {/* ALPHA ONLY carries `data-hotkey="x"` — QA R-2.1 requires beta to have
            no `x` element, so the same stroke must not activate anything there. */}
        <Button
          data-testid={FIXTURE_ELEMENT_TESTID}
          data-hotkey={isAlpha ? FIXTURE_ELEMENT_KEY : undefined}
          size="sm"
          variant="outline"
          onClick={() => runElementActivation(appId)}
        >
          Element x
        </Button>
      </Box>

      <chakra.input
        aria-label="Fixture text entry"
        placeholder="Type in the app"
        type="text"
        autoComplete="off"
        spellCheck={false}
        width="100%"
        maxWidth="320px"
        height="8"
        paddingX="2"
        fontSize="sm"
        color="fg.default"
        bg="bg.subtle"
        borderWidth="1px"
        borderColor="border.default"
        borderRadius="sm"
        _placeholder={{ color: 'fg.subtle' }}
        _focusVisible={{ outline: '2px solid var(--accent-strong)', outlineOffset: '-2px' }}
      />

      <Box display="flex" alignItems="baseline" gap="2">
        <Text fontSize="xs" color="fg.muted" flexShrink={0}>
          Value:
        </Text>
        <Text
          data-testid={FIXTURE_VALUE_TESTID}
          data-command-id={captureId}
          data-command-args-capture={snapshot.argsCapture}
          fontSize="sm"
          fontFamily="mono"
          color="fg.default"
          whiteSpace="nowrap"
          overflow="hidden"
          textOverflow="ellipsis"
        >
          {snapshot.value}
        </Text>
      </Box>
    </Box>
  );
}

// ── The stub applications ────────────────────────────────────────────────────

/** One DEV fixture application; `render()` is its panel. */
export class CommandFixtureApplication extends FredoApplicationClass {
  readonly id: string;
  readonly name: string;
  readonly icon = LuAppWindow;
  readonly commandSurface: ApplicationCommandSurface;

  constructor(id: string, name: string) {
    super();
    this.id = id;
    this.name = name;
    this.commandSurface = buildCommandFixtureSurface(id);
  }

  render(): React.ReactElement {
    return <CommandFixturePanel appId={this.id} />;
  }
}

/**
 * Register both fixture apps ONCE. The registry has no reset (`applicationRegistry`),
 * so registration is keyed by id and is idempotent across `activate()` calls.
 */
export function ensureFixtureApplicationsRegistered(): void {
  const registered = new Set(getApplications().map((application) => application.id));
  if (!registered.has(FIXTURE_ALPHA_ID)) {
    registerApplication(new CommandFixtureApplication(FIXTURE_ALPHA_ID, 'Fixture Alpha'));
  }
  if (!registered.has(FIXTURE_BETA_ID)) {
    registerApplication(new CommandFixtureApplication(FIXTURE_BETA_ID, 'Fixture Beta'));
  }
}
