import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Box, Button, Flex, HStack, Text, Textarea } from '@chakra-ui/react';
import { LuPlay, LuTriangleAlert } from 'react-icons/lu';
import type { DbObjectKind, DbQueryError, QueryMode, TextRange } from '../lib/types';

/**
 * SqlEditor — the query authoring surface (Spec #2950, ST-5).
 *
 * R-3.2: the primary **Run** action executes the current selection when one is
 * present, otherwise the statement at the caret. The caret statement is resolved
 * client-side ([`statementAtCaret`]) and handed to the backend as a `selection`
 * range, because `DbQueryArgs.selection` is the backend's execution scope.
 * R-3.6: **Run all** is a separate, explicitly labelled action that sends
 * `mode: 'all'` — it is never the default.
 * R-3.5: a failed query renders `db-query-error` with the Postgres message and
 * the 1-based line/column when the server supplied one.
 * R-3.9: typing offers schema-driven completion from the loaded `db_schema_list`
 * nodes (passed in as `completions`); the popup is keyboard navigable.
 *
 * `TextRange` offsets are UTF-8 byte offsets into the buffer (the frozen wire
 * contract); the DOM textarea reports UTF-16 code-unit offsets, so they are
 * converted with [`utf16IndexToByteOffset`].
 */

export interface DbCompletion {
  label: string;
  kind: DbObjectKind;
}

/** What the editor asks the workspace to execute. */
export interface SqlRunRequest {
  mode: QueryMode;
  /** `null` => the backend uses the whole buffer (only for `mode: 'all'`). */
  selection: TextRange | null;
}

export interface StatementSpan {
  /** UTF-16 index of the first non-whitespace character. */
  start: number;
  /** UTF-16 index just past the statement's terminating `;` (exclusive). */
  end: number;
}

const COMPLETION_KEYWORDS = /\b(FROM|JOIN|UPDATE|INTO|TABLE|ALTER|REFERENCES|DELETE\s+FROM)\s$/i;

/** Convert a UTF-16 code-unit offset into a UTF-8 byte offset. */
export function utf16IndexToByteOffset(text: string, index: number): number {
  return new TextEncoder().encode(text.slice(0, index)).length;
}

/**
 * Split `sql` into statement spans, respecting single/double quotes, line
 * comments, block comments and dollar-quoted bodies. Semicolons inside those
 * constructs never split.
 */
export function splitStatementSpans(sql: string): StatementSpan[] {
  const spans: StatementSpan[] = [];
  let start = -1;
  let index = 0;
  let quote: "'" | '"' | null = null;
  let dollarTag: string | null = null;
  let lineComment = false;
  let blockCommentDepth = 0;

  const push = (end: number): void => {
    if (start === -1) return;
    if (sql.slice(start, end).trim().length > 0) spans.push({ start, end });
    start = -1;
  };

  while (index < sql.length) {
    const char = sql[index];
    const next = index + 1 < sql.length ? sql[index + 1] : '';

    if (lineComment) {
      if (char === '\n') lineComment = false;
      index += 1;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (char === '/' && next === '*') {
        blockCommentDepth += 1;
        index += 2;
        continue;
      }
      if (char === '*' && next === '/') {
        blockCommentDepth -= 1;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length;
        dollarTag = null;
        continue;
      }
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) {
          index += 2;
          continue;
        }
        quote = null;
        index += 1;
        continue;
      }
      index += 1;
      continue;
    }

    if (char === '-' && next === '-') {
      lineComment = true;
      index += 2;
      continue;
    }
    if (char === '/' && next === '*') {
      blockCommentDepth = 1;
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      index += 1;
      continue;
    }
    if (char === '$') {
      const match = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(index));
      if (match) {
        dollarTag = match[0];
        index += dollarTag.length;
        continue;
      }
    }
    if (char === ';') {
      push(index);
      index += 1;
      continue;
    }
    if (start === -1 && !/\s/.test(char)) start = index;
    index += 1;
  }
  push(sql.length);
  return spans;
}

/**
 * The statement containing the caret. When the caret sits in whitespace between
 * statements, the nearest preceding statement wins (the statement just typed);
 * with no preceding statement the first one is used.
 */
export function statementAtCaret(sql: string, caret: number): StatementSpan | null {
  const spans = splitStatementSpans(sql);
  if (spans.length === 0) return null;
  const containing = spans.find((span) => caret >= span.start && caret <= span.end);
  if (containing) return containing;
  let preceding: StatementSpan | null = null;
  for (const span of spans) if (span.end <= caret) preceding = span;
  return preceding ?? spans[0];
}

function toByteRange(text: string, start: number, end: number): TextRange | null {
  if (end <= start) return null;
  return {
    start: utf16IndexToByteOffset(text, start),
    end: utf16IndexToByteOffset(text, end),
  };
}

interface CompletionContext {
  /** UTF-16 index where the accepted completion replaces text. */
  start: number;
  /** The partial token before the caret (may be empty). */
  text: string;
}

/** Where (if anywhere) a schema completion should open. */
export function completionContext(sql: string, caret: number): CompletionContext | null {
  if (caret <= 0) return null;
  const before = sql.slice(0, caret);
  const dotMatch = /\.([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before);
  if (dotMatch) {
    const text = dotMatch[1] ?? '';
    return { start: caret - text.length, text };
  }
  const wordMatch = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(before);
  if (wordMatch) return { start: caret - wordMatch[1].length, text: wordMatch[1] };
  // After a table-position keyword the user expects the table list (QA-3).
  if (COMPLETION_KEYWORDS.test(before)) return { start: caret, text: '' };
  return null;
}

export interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: (request: SqlRunRequest) => void;
  running?: boolean;
  disabled?: boolean;
  error?: DbQueryError | null;
  completions?: DbCompletion[];
}

export const SqlEditor: React.FC<SqlEditorProps> = ({
  value,
  onChange,
  onRun,
  running = false,
  disabled = false,
  error = null,
  completions = [],
}) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const context = useMemo(() => completionContext(value, caret), [value, caret]);
  const options = useMemo(() => {
    if (!context) return [] as DbCompletion[];
    const needle = context.text.toLowerCase();
    return completions.filter((entry) => entry.label.toLowerCase().startsWith(needle)).slice(0, 8);
  }, [completions, context]);
  const open = !dismissed && options.length > 0;

  const runSingle = useCallback(() => {
    if (disabled || running) return;
    const element = textareaRef.current;
    const start = element?.selectionStart ?? 0;
    const end = element?.selectionEnd ?? 0;
    if (end > start) {
      onRun({ mode: 'single', selection: toByteRange(value, start, end) });
      return;
    }
    const statement = statementAtCaret(value, start);
    onRun({ mode: 'single', selection: statement ? toByteRange(value, statement.start, statement.end) : null });
  }, [disabled, running, onRun, value]);

  const runAll = useCallback(() => {
    if (disabled || running) return;
    onRun({ mode: 'all', selection: null });
  }, [disabled, running, onRun]);

  const accept = useCallback(
    (label: string) => {
      if (!context) return;
      const next = value.slice(0, context.start) + label + value.slice(caret);
      onChange(next);
      setDismissed(true);
      const position = context.start + label.length;
      setCaret(position);
      const element = textareaRef.current;
      if (element) {
        element.focus();
        element.setSelectionRange(position, position);
      }
    },
    [context, value, caret, onChange],
  );

  return (
    <Flex direction="column" gap={2}>
      <HStack gap={2} flexShrink={0} align="center">
        <Button
          data-testid="db-query-run"
          size="xs"
          variant="solid"
          bg="accent.default"
          color="accent.contrast"
          loading={running}
          disabled={disabled}
          onClick={runSingle}
        >
          <LuPlay size={12} />
          Run
        </Button>
        <Button
          data-testid="db-query-run-all"
          size="xs"
          variant="outline"
          disabled={disabled || running}
          onClick={runAll}
        >
          Run all
        </Button>
        <Text fontSize="xs" color="fg.muted">
          Run executes the selection, or the statement at the caret.
        </Text>
      </HStack>

      <Box position="relative">
        <Textarea
          ref={textareaRef}
          data-testid="db-query-editor"
          aria-label="SQL editor"
          value={value}
          disabled={disabled}
          spellCheck={false}
          fontFamily="mono"
          fontSize="sm"
          minHeight="140px"
          resize="vertical"
          bg="bg.surface"
          borderColor="border.default"
          color="fg.default"
          _focus={{ borderColor: 'accent.default', boxShadow: '0 0 0 1px var(--accent-primary)' }}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next);
            const position = event.target.selectionStart;
            setCaret(typeof position === 'number' && position > 0 ? position : next.length);
            setDismissed(false);
          }}
          onSelect={(event) => {
            const element = event.currentTarget;
            setCaret(element.selectionStart ?? element.value.length);
          }}
          onKeyDown={(event) => {
            if (open) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setHighlight((current) => Math.min(current + 1, options.length - 1));
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setHighlight((current) => Math.max(current - 1, 0));
                return;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                accept(options[Math.min(highlight, options.length - 1)].label);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setDismissed(true);
                return;
              }
            }
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              runSingle();
            }
          }}
        />

        {open ? (
          <Box
            data-testid="db-autocomplete"
            role="listbox"
            aria-label="Schema completions"
            position="absolute"
            top="100%"
            left={2}
            zIndex={2}
            minWidth="200px"
            maxHeight="200px"
            overflowY="auto"
            bg="bg.surface"
            borderWidth="1px"
            borderColor="border.default"
            borderRadius="sm"
            boxShadow="shadow.dialog"
          >
            {options.map((option, index) => (
              <Box
                key={`${option.kind}:${option.label}`}
                data-testid="db-autocomplete-option"
                data-selected={index === highlight}
                role="option"
                aria-selected={index === highlight}
                px={2}
                py="2px"
                cursor="pointer"
                bg={index === highlight ? 'accent.subtle' : undefined}
                _hover={{ bg: 'bg.hover' }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  accept(option.label);
                }}
              >
                <HStack gap={2}>
                  <Text
                    fontSize="xs"
                    color="fg.default"
                    flex="1"
                    minWidth={0}
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                  >
                    {option.label}
                  </Text>
                  <Text fontSize="xs" color="fg.muted" flexShrink={0}>
                    {option.kind}
                  </Text>
                </HStack>
              </Box>
            ))}
          </Box>
        ) : null}
      </Box>

      {error ? (
        <Flex
          data-testid="db-query-error"
          role="alert"
          align="flex-start"
          gap={2}
          bg="bg.subtle"
          borderWidth="1px"
          borderColor="status.error"
          borderRadius="sm"
          p={2}
          flexShrink={0}
        >
          <Box color="status.error" display="flex" flexShrink={0} mt="1px">
            <LuTriangleAlert size={13} />
          </Box>
          <Box flex="1" minWidth={0}>
            <Text fontSize="xs" color="status.error" wordBreak="break-word">
              {error.message}
            </Text>
            {error.line != null && error.column != null ? (
              <Text data-testid="db-query-error-position" fontSize="xs" color="fg.muted" mt={1}>
                line {error.line}, column {error.column}
              </Text>
            ) : null}
          </Box>
        </Flex>
      ) : null}
    </Flex>
  );
};
