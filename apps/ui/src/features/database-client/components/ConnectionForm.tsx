import React, { useCallback, useMemo, useState } from 'react';
import { Box, Button, chakra, Flex, HStack, Input, Spinner, Text, VStack } from '@chakra-ui/react';
import { LuCircleCheck, LuTriangleAlert } from 'react-icons/lu';
import { dbConnectionSave, dbConnectionTest, normalizeDbError } from '../lib/api';
import type {
  AccessMode,
  DbConnectionView,
  DbQueryError,
  SslMode,
} from '../lib/types';

/**
 * ConnectionForm — create/edit a saved connection with test-before-save
 * (Spec #2950, ST-7; R-1.1/R-1.2/R-1.3/R-1.4/R-1.6/R-5.1).
 *
 * R-1.2: name/host/port (1–65535)/user/database are validated client-side and
 * invalid input is rejected with a field-level message BEFORE any network call.
 * R-1.3: "Test connection" calls the bounded (10 s) `db_connection_test` and
 * shows the server version on success or the classified typed error on failure.
 * R-1.4: Save is enabled only after a successful test (a new connection), or on
 * edit with an unchanged (blank) password; a failed test leaves Save disabled
 * until a field changes.
 * R-1.6: the password input is write-only — on edit it renders empty with an
 * "unchanged" placeholder and is never echoed back.
 *
 * Token-first: semantic tokens only, no hex/rgba literal.
 */

export interface ConnectionFormProps {
  /** The connection being edited, or `null`/absent when creating (R-5.1). */
  initial?: DbConnectionView | null;
  /** Called after a successful save; the shell reloads + selects. */
  onSaved: (view: DbConnectionView) => void;
  /** Called when the user cancels; the shell closes the form. */
  onCancel?: () => void;
}

type FieldKey = 'name' | 'host' | 'port' | 'user' | 'database';

type FieldErrors = Partial<Record<FieldKey, string>>;

type TestState = 'untested' | 'success' | 'failure';

interface TestOutcome {
  ok: boolean;
  serverVersion: string | null;
  error: DbQueryError | null;
}

const SSL_OPTIONS: { value: SslMode; label: string }[] = [
  { value: 'disable', label: 'Disable' },
  { value: 'prefer', label: 'Prefer' },
  { value: 'require', label: 'Require' },
  { value: 'verifyCa', label: 'Verify CA' },
  { value: 'verifyFull', label: 'Verify Full' },
];

/** Pure client-side validation (R-1.2) — exported for a deterministic pin. */
export function validateConnectionFields(input: {
  name: string;
  host: string;
  port: string;
  user: string;
  database: string;
}): FieldErrors {
  const errors: FieldErrors = {};
  if (!input.name.trim()) errors.name = 'Name is required';
  if (!input.host.trim()) errors.host = 'Host is required';
  const port = Number(input.port);
  if (!input.port.trim()) {
    errors.port = 'Port is required';
  } else if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.port = 'Port must be between 1 and 65535';
  }
  if (!input.user.trim()) errors.user = 'User is required';
  if (!input.database.trim()) errors.database = 'Database is required';
  return errors;
}

interface FieldProps {
  label: string;
  testId: string;
  errorId?: string;
  error?: string;
  children: React.ReactNode;
}

const Field: React.FC<FieldProps> = ({ label, testId, errorId, error, children }) => (
  <Box data-testid={testId}>
    <Text as="label" display="block" fontSize="xs" fontWeight="600" color="fg.muted" mb={1}>
      {label}
    </Text>
    {children}
    {error ? (
      <Text
        data-testid={errorId}
        role="alert"
        fontSize="xs"
        color="status.error"
        mt={1}
      >
        {error}
      </Text>
    ) : null}
  </Box>
);

export const ConnectionForm: React.FC<ConnectionFormProps> = ({
  initial = null,
  onSaved,
  onCancel,
}) => {
  const isEditing = Boolean(initial?.id);

  const [name, setName] = useState(initial?.name ?? '');
  const [host, setHost] = useState(initial?.host ?? '127.0.0.1');
  const [port, setPort] = useState(initial ? String(initial.port) : '5432');
  const [user, setUser] = useState(initial?.user ?? 'postgres');
  const [password, setPassword] = useState('');
  const [database, setDatabase] = useState(initial?.database ?? 'postgres');
  const [sslMode, setSslMode] = useState<SslMode>(initial?.sslMode ?? 'prefer');
  const [accessMode, setAccessMode] = useState<AccessMode>(initial?.accessMode ?? 'readOnly');

  const [errors, setErrors] = useState<FieldErrors>({});
  const [testState, setTestState] = useState<TestState>('untested');
  const [testOutcome, setTestOutcome] = useState<TestOutcome | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fields = useMemo(
    () => ({ name, host, port, user, database }),
    [name, host, port, user, database],
  );
  const validation = useMemo(() => validateConnectionFields(fields), [fields]);
  const isValid = Object.keys(validation).length === 0;

  /**
   * R-1.4: a successful test (or an unchanged-secret edit) enables Save; a
   * failed test keeps Save disabled until a field changes (which resets to
   * `untested`).
   */
  const canSave =
    isValid &&
    testState !== 'failure' &&
    (testState === 'success' || (isEditing && password.trim() === ''));

  /** A field edit invalidates any prior test result (R-1.4). */
  const onFieldChange = useCallback(() => {
    setTestState('untested');
    setTestOutcome(null);
    setShowDetails(false);
  }, []);

  const handleTest = useCallback(async () => {
    const nextErrors = validateConnectionFields(fields);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setTesting(true);
    setSaveError(null);
    try {
      const result = await dbConnectionTest({
        engine: 'postgres',
        host: host.trim(),
        port: Number(port),
        user: user.trim(),
        database: database.trim(),
        sslMode,
        password: password.trim() ? password : null,
      });
      setTestOutcome(result);
      setTestState(result.ok ? 'success' : 'failure');
      setShowDetails(false);
    } catch (error) {
      setTestOutcome({
        ok: false,
        serverVersion: null,
        error: { kind: 'other', message: normalizeDbError(error) },
      });
      setTestState('failure');
    } finally {
      setTesting(false);
    }
  }, [fields, host, port, user, database, sslMode, password]);

  const handleSave = useCallback(async () => {
    const nextErrors = validateConnectionFields(fields);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !canSave) return;

    setSaving(true);
    setSaveError(null);
    try {
      const view = await dbConnectionSave({
        id: initial?.id ?? null,
        name: name.trim(),
        engine: 'postgres',
        host: host.trim(),
        port: Number(port),
        user: user.trim(),
        database: database.trim(),
        sslMode,
        accessMode,
        password: password.trim() ? password : null,
      });
      onSaved(view);
    } catch (error) {
      setSaveError(normalizeDbError(error));
    } finally {
      setSaving(false);
    }
  }, [fields, canSave, initial, name, host, port, user, database, sslMode, accessMode, password, onSaved]);

  const inputProps = {
    size: 'sm' as const,
    bg: 'bg.surface',
    borderColor: 'border.default',
    color: 'fg.default',
    _focus: { borderColor: 'accent.default' },
  };

  return (
    <Flex
      data-testid="db-connection-form"
      as="form"
      direction="column"
      gap={3}
      p={3}
      bg="bg.surface"
      borderWidth="1px"
      borderColor="border.default"
      borderRadius="sm"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSave();
      }}
    >
      <Text fontSize="sm" fontWeight="600" color="fg.default">
        {isEditing ? 'Edit connection' : 'New connection'}
      </Text>

      <VStack align="stretch" gap={2}>
        <Field label="Name" testId="db-conn-name-field" errorId="db-conn-error-name" error={errors.name}>
          <Input
            data-testid="db-conn-name"
            {...inputProps}
            value={name}
            aria-label="Connection name"
            aria-invalid={Boolean(errors.name)}
            onChange={(event) => {
              setName(event.target.value);
              onFieldChange();
            }}
          />
        </Field>

        <HStack align="flex-start" gap={2}>
          <Box flex="2">
            <Field label="Host" testId="db-conn-host-field" errorId="db-conn-error-host" error={errors.host}>
              <Input
                data-testid="db-conn-host"
                {...inputProps}
                value={host}
                aria-label="Host"
                aria-invalid={Boolean(errors.host)}
                onChange={(event) => {
                  setHost(event.target.value);
                  onFieldChange();
                }}
              />
            </Field>
          </Box>
          <Box flex="1">
            <Field label="Port" testId="db-conn-port-field" errorId="db-conn-error-port" error={errors.port}>
              <Input
                data-testid="db-conn-port"
                {...inputProps}
                type="number"
                value={port}
                aria-label="Port"
                aria-invalid={Boolean(errors.port)}
                onChange={(event) => {
                  setPort(event.target.value);
                  onFieldChange();
                }}
              />
            </Field>
          </Box>
        </HStack>

        <Field label="User" testId="db-conn-user-field" errorId="db-conn-error-user" error={errors.user}>
          <Input
            data-testid="db-conn-user"
            {...inputProps}
            value={user}
            aria-label="User"
            aria-invalid={Boolean(errors.user)}
            onChange={(event) => {
              setUser(event.target.value);
              onFieldChange();
            }}
          />
        </Field>

        <Field
          label="Password"
          testId="db-conn-password-field"
          errorId="db-conn-error-password"
        >
          <Input
            data-testid="db-conn-password"
            {...inputProps}
            type="password"
            value={password}
            aria-label="Password"
            placeholder={isEditing ? 'unchanged' : 'password'}
            autoComplete="new-password"
            onChange={(event) => {
              setPassword(event.target.value);
              onFieldChange();
            }}
          />
        </Field>

        <Field
          label="Database"
          testId="db-conn-database-field"
          errorId="db-conn-error-database"
          error={errors.database}
        >
          <Input
            data-testid="db-conn-database"
            {...inputProps}
            value={database}
            aria-label="Database"
            aria-invalid={Boolean(errors.database)}
            onChange={(event) => {
              setDatabase(event.target.value);
              onFieldChange();
            }}
          />
        </Field>

        <HStack gap={2}>
          <Box flex="1">
            <Field label="SSL mode" testId="db-conn-ssl-field">
              <chakra.select
                data-testid="db-conn-ssl"
                aria-label="SSL mode"
                value={sslMode}
                width="100%"
                px={2}
                py="6px"
                fontSize="sm"
                bg="bg.surface"
                borderWidth="1px"
                borderColor="border.default"
                borderRadius="md"
                color="fg.default"
                onChange={(event) => {
                  setSslMode(event.target.value as SslMode);
                  onFieldChange();
                }}
              >
                {SSL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </chakra.select>
            </Field>
          </Box>
          <Box flex="1">
            <Field label="Access mode" testId="db-conn-access-mode-field">
              <chakra.select
                data-testid="db-conn-access-mode"
                aria-label="Access mode"
                value={accessMode}
                width="100%"
                px={2}
                py="6px"
                fontSize="sm"
                bg="bg.surface"
                borderWidth="1px"
                borderColor="border.default"
                borderRadius="md"
                color="fg.default"
                onChange={(event) => {
                  setAccessMode(event.target.value as AccessMode);
                  onFieldChange();
                }}
              >
                <option value="readOnly">Read-only</option>
                <option value="readWrite">Read/write</option>
              </chakra.select>
            </Field>
          </Box>
        </HStack>
      </VStack>

      <Flex
        data-testid="db-connection-test-result"
        data-state={testState}
        role={testState === 'failure' ? 'alert' : 'status'}
        align="flex-start"
        gap={2}
        bg="bg.subtle"
        borderWidth="1px"
        borderColor={testState === 'failure' ? 'status.error' : 'border.default'}
        borderRadius="sm"
        p={2}
        minHeight="32px"
      >
        {testing ? (
          <>
            <Spinner size="xs" color="accent.default" flexShrink={0} />
            <Text fontSize="xs" color="fg.muted">
              Testing connection…
            </Text>
          </>
        ) : testOutcome?.ok ? (
          <>
            <Box color="status.success" display="flex" flexShrink={0} mt="1px" aria-hidden="true">
              <LuCircleCheck size={13} />
            </Box>
            <Box flex="1" minWidth={0}>
              <Text data-testid="db-conn-test-success" fontSize="xs" color="status.success">
                Connected · {testOutcome.serverVersion ?? 'server reachable'}
              </Text>
            </Box>
          </>
        ) : testOutcome ? (
          <>
            <Box color="status.error" display="flex" flexShrink={0} mt="1px" aria-hidden="true">
              <LuTriangleAlert size={13} />
            </Box>
            <Box flex="1" minWidth={0}>
              <Text data-testid="db-conn-test-failure" fontSize="xs" color="status.error">
                {testOutcome.error?.message ?? 'Connection failed'}
              </Text>
              <Button
                data-testid="db-conn-test-details"
                size="xs"
                variant="ghost"
                color="fg.muted"
                mt={1}
                onClick={() => setShowDetails((value) => !value)}
              >
                {showDetails ? 'Hide details' : 'Show details'}
              </Button>
              {showDetails ? (
                <Text
                  data-testid="db-conn-test-details-panel"
                  mt={1}
                  fontSize="2xs"
                  fontFamily="mono"
                  color="fg.muted"
                  wordBreak="break-word"
                >
                  {testOutcome.error?.kind ?? 'other'}: {testOutcome.error?.message ?? ''}
                </Text>
              ) : null}
            </Box>
          </>
        ) : (
          <Text data-testid="db-conn-test-hint" fontSize="xs" color="fg.muted">
            Test the connection before saving.
          </Text>
        )}
      </Flex>

      {saveError ? (
        <Text data-testid="db-conn-save-error" role="alert" fontSize="xs" color="status.error">
          {saveError}
        </Text>
      ) : null}

      <HStack justify="flex-end" gap={2}>
        {onCancel ? (
          <Button data-testid="db-conn-cancel" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          data-testid="db-conn-test"
          size="sm"
          variant="outline"
          loading={testing}
          onClick={() => void handleTest()}
        >
          Test connection
        </Button>
        <Button
          data-testid="db-conn-save"
          size="sm"
          variant="solid"
          bg="accent.default"
          color="accent.contrast"
          loading={saving}
          disabled={!canSave}
          onClick={() => void handleSave()}
        >
          Save
        </Button>
      </HStack>
    </Flex>
  );
};
