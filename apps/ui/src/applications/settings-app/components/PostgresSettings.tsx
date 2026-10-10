/**
 * PostgresSettings — Settings → Database (Spec #3022 ST-8; EARS R-2.2, R-3.1,
 * R-3.2, R-3.3, R-4, R-5.1; plan UI/UX §2–§9).
 *
 * The ONE user-facing pane for the embedded PostgreSQL cluster: change the
 * write-only password, choose the port (Automatic / Fixed), set log verbosity,
 * apply them together with a single **Apply**, and recover a drifted credential
 * via the explicitly-warned destructive **Reset database** action.
 *
 * Design contract:
 *  - The status strip is the single continuous-feedback channel (`role="status"`
 *    `aria-live="polite"` `aria-busy={busy}`, section-local); states are icon +
 *    colour + text (never colour alone), and the effective config is always
 *    visible (recognition over recall). Never a toast.
 *  - Password is write-only: `type="password"`, `autoComplete="new-password"`,
 *    NO reveal toggle, cleared on every Apply completion and on unmount (state
 *    dies with the component). The store's config view carries no password field.
 *  - ONE primary action (`Apply`); the shared Save footer stays hidden because
 *    this pane never registers a `saveFn` with `SettingsSaveContext`.
 *  - Token-first chrome: semantic tokens + CSS vars + the shared `tint()` helper.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  chakra,
  Checkbox,
  Dialog,
  Field,
  HStack,
  Icon,
  Input,
  Portal,
  RadioCard,
  Separator,
  Skeleton,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react';
import { LuCircle, LuCircleCheck, LuLoader, LuTriangleAlert } from 'react-icons/lu';

import { tint } from '../../../shared/utils/colorTint';
import {
  applyPostgresConfig,
  DEFAULT_PG_CONFIG,
  DEFAULT_PG_LOG_VERBOSITY,
  getPgSupervisorStatus,
  getPostgresConfig,
  PG_LOG_VERBOSITY_LABELS,
  PG_LOG_VERBOSITY_VALUES,
  PG_PORT_MAX,
  PG_PORT_MIN,
  resetPostgresDatabase,
  type PgConfigView,
  type PgLogVerbosity,
  type PgPortMode,
  type PgSupervisorStatusView,
} from '../../postgres/postgresConfigStore';

// ── Copy (exact strings from the plan's UI/UX copy tables) ────────────────────

const SECTION_TITLE = 'PostgreSQL store';
const SECTION_HELP =
  'Configure the embedded PostgreSQL cluster used for local persistence. Changes restart it.';
const PASSWORD_LABEL = 'Database password';
const PASSWORD_HELP = 'Write-only — the current password is never displayed.';
const PORT_LABEL = 'Port';
const PORT_AUTO_HELP = 'The OS assigns a free port at each start.';
const PORT_FIXED_HELP = '1–65535';
const PORT_RANGE_ERROR = 'Enter a port between 1 and 65535.';
const VERBOSITY_LABEL = 'Log verbosity';
const APPLY_LABEL = 'Apply';
const RESET_LABEL = 'Reset database…';
const DRIFT_TEXT =
  'Password mismatch — the stored password does not match the running cluster. Reset the database to recover.';
const UNAVAILABLE_TEXT = 'Database is not ready.';
const APPLY_SUCCESS_TEXT = 'Database restarted and reconnected.';
const RESET_SUCCESS_TEXT = 'Database reset. All previous data was deleted.';
const BUSY_APPLY_TEXT = 'Applying changes… restarting the database.';
const BUSY_RESET_TEXT = 'Re-initializing the database… all data will be deleted.';
const RESET_DIALOG_TITLE = 'Reset the database?';
const RESET_DIALOG_BODY =
  'This re-initializes the embedded PostgreSQL cluster with the currently stored password. All data — sessions, events, telemetry, and application data — will be permanently deleted. This cannot be undone and there is no backup.';
const RESET_ACK_LABEL = 'I understand all data will be deleted.';
const RESET_CONFIRM_LABEL = 'Reset database';
const CANCEL_LABEL = 'Cancel';

/** The step readout shown while a restart is in flight (Doherty). */
const APPLY_STEPS = ['Saving config…', 'Restarting cluster…', 'Reconnecting…'] as const;

/** The select chrome (CSS vars so it follows the user theme — never NativeSelect). */
const selectStyles = {
  width: 'auto',
  minW: '200px',
  p: 2,
  borderRadius: 'md',
  bg: 'var(--card-bg)',
  border: '1px solid',
  borderColor: 'var(--border-color)',
  color: 'var(--text-primary)',
  fontSize: 'sm',
  cursor: 'pointer',
  _hover: { borderColor: 'var(--accent-primary)' },
  _focus: {
    outline: 'none',
    borderColor: 'var(--accent-primary)',
    boxShadow: '0 0 0 1px var(--accent-primary)',
  },
  _disabled: { opacity: 0.5, cursor: 'not-allowed' },
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SupervisorKind = 'ready' | 'drifted' | 'unavailable';

/** The single supervisor→pane classification (fail-closed engine-not-ready). */
function classifySupervisor(status: PgSupervisorStatusView | null): SupervisorKind {
  if (!status) return 'unavailable';
  if (status.state === 'ready') return 'ready';
  if (status.state === 'failed' && status.failureKind === 'authMismatch') return 'drifted';
  return 'unavailable';
}

interface StripView {
  readonly text: string;
  readonly color: string;
  readonly icon: React.ElementType;
  readonly spin: boolean;
}

/** One port-mode radio card (Automatic / Fixed). */
const PortModeOption: React.FC<{
  value: PgPortMode;
  title: string;
  description: string;
  selected: boolean;
}> = ({ value, title, description, selected }) => (
  <RadioCard.Item value={value}>
    <RadioCard.ItemHiddenInput
      aria-checked={selected}
      data-testid={`settings-postgres-port-mode-${value}`}
    />
    <RadioCard.ItemControl
      borderWidth="1px"
      borderRadius="md"
      borderColor={selected ? 'var(--accent-primary)' : 'border.default'}
      bg={selected ? tint('var(--accent-primary)', 12) : 'bg.surface'}
      transition="background 0.15s ease, border-color 0.15s ease"
      _hover={{ borderColor: 'var(--accent-primary)' }}
      _focusWithin={{ outline: '2px solid var(--accent-primary)', outlineOffset: '2px' }}
    >
      <RadioCard.ItemContent>
        <RadioCard.ItemText fontWeight="600" color="fg.default">
          {title}
        </RadioCard.ItemText>
        <RadioCard.ItemDescription color="fg.muted">{description}</RadioCard.ItemDescription>
      </RadioCard.ItemContent>
      <RadioCard.ItemIndicator />
    </RadioCard.ItemControl>
  </RadioCard.Item>
);

// ── Component ─────────────────────────────────────────────────────────────────

export const PostgresSettings: React.FC = () => {
  // Effective config (no secret) + supervisor state.
  const [config, setConfig] = useState<PgConfigView | null>(null);
  const [supervisor, setSupervisor] = useState<PgSupervisorStatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // Draft form state.
  const [password, setPassword] = useState('');
  const [portMode, setPortMode] = useState<PgPortMode>('auto');
  const [portText, setPortText] = useState('');
  const [verbosity, setVerbosity] = useState<PgLogVerbosity>(DEFAULT_PG_LOG_VERBOSITY);

  // Operation state.
  const [applying, setApplying] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [portFieldError, setPortFieldError] = useState<string | null>(null);
  const [applyStep, setApplyStep] = useState(0);

  // Reset dialog state.
  const [resetOpen, setResetOpen] = useState(false);
  const [resetAck, setResetAck] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const resetTriggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const hydrateDrafts = useCallback((view: PgConfigView) => {
    setPortMode(view.portMode);
    setPortText(view.portMode === 'fixed' && view.port !== null ? String(view.port) : '');
    setVerbosity(view.logVerbosity);
  }, []);

  // On mount: fetch the effective config + supervisor state (skeleton while loading).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [configResult, statusResult] = await Promise.allSettled([
        getPostgresConfig(),
        getPgSupervisorStatus(),
      ]);
      if (cancelled) return;
      if (configResult.status === 'fulfilled') {
        setConfig(configResult.value);
        hydrateDrafts(configResult.value);
        setLoadError(false);
      } else {
        setConfig({ ...DEFAULT_PG_CONFIG });
        hydrateDrafts(DEFAULT_PG_CONFIG);
        setLoadError(true);
      }
      setSupervisor(statusResult.status === 'fulfilled' ? statusResult.value : { state: 'disabled' });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // The password lives in component state only, so it is destroyed on unmount.
  }, [hydrateDrafts]);

  // Cycle the step readout while a restart is in flight (bounded, self-clearing).
  useEffect(() => {
    if (!applying) {
      setApplyStep(0);
      return;
    }
    const id = window.setInterval(
      () => setApplyStep((step) => Math.min(step + 1, APPLY_STEPS.length - 1)),
      2500,
    );
    return () => window.clearInterval(id);
  }, [applying]);

  const supervisorKind = classifySupervisor(supervisor);
  const drifted = supervisorKind === 'drifted';
  const engineUnavailable = loadError || supervisorKind === 'unavailable';
  const busy = applying || resetting;
  const controlsDisabled = busy || engineUnavailable;

  const parsedPort = /^\d+$/.test(portText.trim()) ? Number.parseInt(portText.trim(), 10) : NaN;
  const portValid =
    portMode === 'auto' ||
    (Number.isInteger(parsedPort) && parsedPort >= PG_PORT_MIN && parsedPort <= PG_PORT_MAX);

  const effectivePortText =
    config && config.portMode === 'fixed' && config.port !== null ? String(config.port) : '';
  const dirty =
    config !== null &&
    (password.length > 0 ||
      portMode !== config.portMode ||
      (portMode === 'fixed' && portText.trim() !== effectivePortText) ||
      verbosity !== config.logVerbosity);
  const canApply = !controlsDisabled && dirty && portValid;

  const portSummary =
    config && config.portMode === 'fixed' && config.port !== null
      ? `Fixed port ${config.port}`
      : 'Automatic';

  const strip = useMemo<StripView>(() => {
    if (applying) return { text: BUSY_APPLY_TEXT, color: 'status.warning', icon: LuLoader, spin: true };
    if (resetting) return { text: BUSY_RESET_TEXT, color: 'status.warning', icon: LuLoader, spin: true };
    if (lastError) {
      return { text: `Last change failed: ${lastError}`, color: 'status.error', icon: LuTriangleAlert, spin: false };
    }
    if (drifted) return { text: DRIFT_TEXT, color: 'status.warning', icon: LuTriangleAlert, spin: false };
    if (engineUnavailable) return { text: UNAVAILABLE_TEXT, color: 'fg.muted', icon: LuCircle, spin: false };
    return {
      text: `Connected — ${portSummary} · ${PG_LOG_VERBOSITY_LABELS[config?.logVerbosity ?? DEFAULT_PG_LOG_VERBOSITY]}`,
      color: 'status.success',
      icon: LuCircleCheck,
      spin: false,
    };
  }, [applying, resetting, lastError, drifted, engineUnavailable, portSummary, config?.logVerbosity]);

  // ── Apply ─────────────────────────────────────────────────────────────────────

  const handleApply = useCallback(async () => {
    if (!config || controlsDisabled || !portValid) return;
    setLastError(null);
    setApplyResult(null);
    setPortFieldError(null);
    setApplying(true);
    try {
      const result = await applyPostgresConfig({
        port: portMode === 'auto' ? null : parsedPort,
        logVerbosity: verbosity,
        newPassword: password.length > 0 ? password : undefined,
      });
      // Re-read the effective config + supervisor state after the restart.
      const [configResult, statusResult] = await Promise.allSettled([
        getPostgresConfig(),
        getPgSupervisorStatus(),
      ]);
      const nextConfig = configResult.status === 'fulfilled' ? configResult.value : null;
      const nextStatus = statusResult.status === 'fulfilled' ? statusResult.value : null;
      // Write-only: the password is cleared on EVERY Apply completion.
      setPassword('');
      if (nextConfig) setConfig(nextConfig);
      if (nextStatus) setSupervisor(nextStatus);

      if (!result.ok) {
        const reason = result.error ?? 'unknown error';
        setLastError(reason);
        setApplyResult({ ok: false, message: `Could not apply changes: ${reason}` });
        if (nextStatus?.failureKind === 'portInUse') {
          // Collision: name the port at the field AND in the strip; keep the draft
          // so the user can correct it (the backend retains the prior config).
          setPortFieldError(
            `Port ${parsedPort} is already in use. Choose another port or switch to Automatic.`,
          );
        } else if (nextConfig) {
          hydrateDrafts(nextConfig);
        }
        return;
      }
      setApplyResult({ ok: true, message: APPLY_SUCCESS_TEXT });
      if (nextConfig) hydrateDrafts(nextConfig);
    } catch (cause) {
      const reason = messageOf(cause);
      setPassword('');
      setLastError(reason);
      setApplyResult({ ok: false, message: `Could not apply changes: ${reason}` });
      hydrateDrafts(config);
    } finally {
      setApplying(false);
    }
  }, [
    config,
    controlsDisabled,
    portValid,
    portMode,
    parsedPort,
    verbosity,
    password,
    hydrateDrafts,
  ]);

  // ── Reset ─────────────────────────────────────────────────────────────────────

  const openReset = useCallback(() => {
    setResetAck(false);
    setResetError(null);
    setResetOpen(true);
  }, []);

  const closeReset = useCallback(() => {
    if (resetting) return;
    setResetOpen(false);
    setResetAck(false);
    setResetError(null);
  }, [resetting]);

  const confirmReset = useCallback(async () => {
    if (resetting || !resetAck) return;
    setResetError(null);
    setResetting(true);
    try {
      const result = await resetPostgresDatabase();
      if (!result.ok) {
        // Failure: stay open, show the error inline.
        setResetError(result.error ?? 'unknown error');
        return;
      }
      const [configResult, statusResult] = await Promise.allSettled([
        getPostgresConfig(),
        getPgSupervisorStatus(),
      ]);
      setPassword('');
      if (configResult.status === 'fulfilled') {
        setConfig(configResult.value);
        hydrateDrafts(configResult.value);
      }
      if (statusResult.status === 'fulfilled') setSupervisor(statusResult.value);
      setResetOpen(false);
      setResetAck(false);
      setLastError(null);
      setPortFieldError(null);
      setApplyResult({ ok: true, message: RESET_SUCCESS_TEXT });
    } catch (cause) {
      setResetError(messageOf(cause));
    } finally {
      setResetting(false);
    }
  }, [resetting, resetAck, hydrateDrafts]);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <>
      <Card.Root
        data-testid="settings-postgres-section"
        bg="bg.surface"
        border="1px solid"
        borderColor="border.default"
        borderRadius="lg"
        w="100%"
      >
        <Card.Body display="flex" flexDirection="column" gap={4}>
          {/* ── Title + help ── */}
          <VStack align="stretch" gap={0}>
            <Text as="h3" fontWeight="600" color="fg.default">
              {SECTION_TITLE}
            </Text>
            <Text fontSize="sm" color="fg.muted">
              {SECTION_HELP}
            </Text>
          </VStack>

          {/* ── Status strip (section-local live region) ── */}
          <VStack
            data-testid="settings-postgres-status"
            role="status"
            aria-live="polite"
            aria-busy={busy}
            align="stretch"
            gap={1}
          >
            {loading ? (
              <>
                <Skeleton height="4" width="55%" />
                <Skeleton height="4" width="80%" />
              </>
            ) : (
              <>
                <HStack gap={2} color={strip.color} align="flex-start">
                  {strip.spin ? (
                    <Spinner size="xs" flexShrink={0} mt="2px" />
                  ) : (
                    <Icon as={strip.icon} boxSize="14px" flexShrink={0} mt="2px" />
                  )}
                  <Text fontSize="sm">{strip.text}</Text>
                </HStack>
                {applying ? (
                  <Text fontSize="xs" color="fg.muted">
                    Step: {APPLY_STEPS[applyStep]}
                  </Text>
                ) : null}
                <Text fontSize="xs" color="fg.muted">
                  Port: {portSummary} · Log verbosity:{' '}
                  {PG_LOG_VERBOSITY_LABELS[config?.logVerbosity ?? DEFAULT_PG_LOG_VERBOSITY]}
                </Text>
              </>
            )}
          </VStack>

          {/* ── Password (write-only) ── */}
          <Field.Root>
            <Field.Label>{PASSWORD_LABEL}</Field.Label>
            <Input
              data-testid="settings-postgres-password"
              type="password"
              autoComplete="new-password"
              placeholder="Enter new password"
              value={password}
              disabled={controlsDisabled}
              onChange={(event) => {
                setPassword(event.target.value);
                setApplyResult(null);
              }}
            />
            <Field.HelperText>{PASSWORD_HELP}</Field.HelperText>
          </Field.Root>

          {/* ── Port ── */}
          <Field.Root>
            <Field.Label>{PORT_LABEL}</Field.Label>
            <RadioCard.Root
              value={portMode}
              onValueChange={(details) => {
                if (details.value) {
                  setPortMode(details.value as PgPortMode);
                  setPortFieldError(null);
                  setApplyResult(null);
                }
              }}
              orientation="horizontal"
              gap={2}
              disabled={controlsDisabled}
              aria-label={PORT_LABEL}
              data-testid="settings-postgres-port-mode"
            >
              <HStack gap={2}>
                <PortModeOption
                  value="auto"
                  title="Automatic"
                  description={PORT_AUTO_HELP}
                  selected={portMode === 'auto'}
                />
                <PortModeOption
                  value="fixed"
                  title="Fixed"
                  description="Pin a specific port."
                  selected={portMode === 'fixed'}
                />
              </HStack>
            </RadioCard.Root>
            {portMode === 'fixed' ? (
              <Input
                data-testid="settings-postgres-port-input"
                type="number"
                inputMode="numeric"
                min={PG_PORT_MIN}
                max={PG_PORT_MAX}
                step={1}
                size="sm"
                maxW="160px"
                mt={2}
                value={portText}
                disabled={controlsDisabled}
                aria-invalid={!portValid}
                onChange={(event) => {
                  setPortText(event.target.value);
                  setPortFieldError(null);
                  setApplyResult(null);
                }}
              />
            ) : null}
            {portMode === 'fixed' && !portValid ? (
              <Field.ErrorText>{PORT_RANGE_ERROR}</Field.ErrorText>
            ) : null}
            {portFieldError ? (
              <Text data-testid="settings-postgres-port-error" fontSize="xs" color="status.error">
                {portFieldError}
              </Text>
            ) : null}
            <Field.HelperText>{portMode === 'fixed' ? PORT_FIXED_HELP : PORT_AUTO_HELP}</Field.HelperText>
          </Field.Root>

          {/* ── Log verbosity ── */}
          <Field.Root>
            <Field.Label>{VERBOSITY_LABEL}</Field.Label>
            <chakra.select
              {...selectStyles}
              data-testid="settings-postgres-log-verbosity"
              aria-label={VERBOSITY_LABEL}
              value={verbosity}
              disabled={controlsDisabled}
              onChange={(event) => {
                setVerbosity(event.target.value as PgLogVerbosity);
                setApplyResult(null);
              }}
            >
              {PG_LOG_VERBOSITY_VALUES.map((value) => (
                <option key={value} value={value}>
                  {PG_LOG_VERBOSITY_LABELS[value]}
                </option>
              ))}
            </chakra.select>
          </Field.Root>

          <Separator borderColor="border.default" />

          {/* ── Actions ── */}
          <HStack justify="space-between" align="center" gap={3}>
            <Button
              ref={resetTriggerRef}
              data-testid="settings-postgres-reset"
              variant="solid"
              bg="status.error"
              color="fg.onAccent"
              borderWidth={drifted ? '2px' : undefined}
              borderColor={drifted ? 'status.warning' : undefined}
              disabled={busy || engineUnavailable}
              onClick={openReset}
            >
              {RESET_LABEL}
            </Button>
            <Button
              data-testid="settings-postgres-apply"
              variant="solid"
              bg="var(--accent-primary)"
              color="var(--accent-contrast)"
              _hover={{ opacity: 0.9 }}
              loading={applying}
              disabled={!canApply}
              onClick={() => void handleApply()}
            >
              {APPLY_LABEL}
            </Button>
          </HStack>

          {/* ── Inline result (persistent icon + colour + text) ── */}
          {applyResult ? (
            <HStack
              data-testid="settings-postgres-apply-result"
              gap={2}
              align="flex-start"
              color={applyResult.ok ? 'status.success' : 'status.error'}
            >
              <Icon
                as={applyResult.ok ? LuCircleCheck : LuTriangleAlert}
                boxSize="14px"
                flexShrink={0}
                mt="2px"
              />
              <Text fontSize="sm">{applyResult.message}</Text>
            </HStack>
          ) : null}
        </Card.Body>
      </Card.Root>

      {/* ── Reset confirmation (real alertdialog) ── */}
      <Dialog.Root
        open={resetOpen}
        onOpenChange={(details) => {
          if (!details.open) closeReset();
        }}
        role="alertdialog"
        initialFocusEl={() => cancelRef.current}
        finalFocusEl={() => resetTriggerRef.current}
      >
        <Portal>
          <Dialog.Backdrop bg="var(--overlay-bg)" />
          <Dialog.Positioner>
            <Dialog.Content
              data-testid="settings-postgres-reset-dialog"
              bg="var(--card-bg)"
              borderColor="var(--border-color)"
              borderWidth="1px"
              borderRadius="lg"
              maxW="lg"
            >
              <Dialog.Header>
                <Dialog.Title color="fg.default">{RESET_DIALOG_TITLE}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  {resetting ? (
                    <HStack role="status" aria-live="polite" gap={2} color="status.warning">
                      <Spinner size="xs" />
                      <Text fontSize="sm">Re-initializing the database…</Text>
                    </HStack>
                  ) : (
                    <>
                      <Dialog.Description color="fg.muted" fontSize="sm">
                        {RESET_DIALOG_BODY}
                      </Dialog.Description>
                      <Checkbox.Root
                        checked={resetAck}
                        onCheckedChange={(details) => setResetAck(!!details.checked)}
                      >
                        <Checkbox.HiddenInput data-testid="settings-postgres-reset-ack" />
                        <Checkbox.Control />
                        <Checkbox.Label>{RESET_ACK_LABEL}</Checkbox.Label>
                      </Checkbox.Root>
                      {resetError ? (
                        <HStack
                          data-testid="settings-postgres-reset-error"
                          gap={2}
                          align="flex-start"
                          color="status.error"
                        >
                          <Icon as={LuTriangleAlert} boxSize="14px" flexShrink={0} mt="2px" />
                          <Text fontSize="sm">Could not reset the database: {resetError}</Text>
                        </HStack>
                      ) : null}
                    </>
                  )}
                </VStack>
              </Dialog.Body>
              <Dialog.Footer gap={2}>
                <Button
                  ref={cancelRef}
                  data-testid="settings-postgres-reset-cancel"
                  variant="ghost"
                  color="var(--text-secondary)"
                  disabled={resetting}
                  onClick={closeReset}
                >
                  {CANCEL_LABEL}
                </Button>
                <Button
                  data-testid="settings-postgres-reset-confirm"
                  variant="solid"
                  bg="status.error"
                  color="fg.onAccent"
                  loading={resetting}
                  disabled={!resetAck}
                  onClick={() => void confirmReset()}
                >
                  {RESET_CONFIRM_LABEL}
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
};
