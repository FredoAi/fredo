/**
 * SqlEditor tests (Spec #2950, ST-5).
 *
 * Pins R-3.2 (selection vs statement-at-caret, resolved to UTF-8 byte offsets),
 * R-3.6 ("Run all" is a separate explicit action), R-3.5 (error with 1-based
 * line/column) and R-3.9 (schema-driven completion).
 */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  SqlEditor,
  splitStatementSpans,
  statementAtCaret,
  type DbCompletion,
} from '../SqlEditor';
import type { DbQueryError } from '../../lib/types';

afterEach(() => {
  cleanup();
});

const completions: DbCompletion[] = [
  { label: 'users', kind: 'table' },
  { label: 'orders', kind: 'table' },
];

/** Stateful harness so controlled typing updates the editor's value. */
function EditorHarness({
  initial = '',
  onChange,
}: {
  initial?: string;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SqlEditor
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      onRun={() => {}}
      completions={completions}
    />
  );
}

describe('SqlEditor — statement splitting helpers', () => {
  it('splits on top-level semicolons and keeps the spans in order', () => {
    const spans = splitStatementSpans('SELECT 1;\nSELECT 2;');
    expect(spans).toEqual([
      { start: 0, end: 8 },
      { start: 10, end: 18 },
    ]);
  });

  it('does not split inside quotes, comments or dollar-quoted bodies', () => {
    expect(splitStatementSpans("SELECT ';' AS x; SELECT 2")).toHaveLength(2);
    expect(splitStatementSpans('SELECT 1 -- ; not a split\n; SELECT 2')).toHaveLength(2);
    expect(splitStatementSpans('SELECT $$a;b$$; SELECT 2')).toHaveLength(2);
  });

  it('resolves the caret statement, preferring the preceding statement in whitespace', () => {
    expect(statementAtCaret('SELECT 1;\nSELECT 2;', 14)).toEqual({ start: 10, end: 18 });
    expect(statementAtCaret('SELECT 1;\nSELECT 2;', 19)).toEqual({ start: 10, end: 18 });
    expect(statementAtCaret('SELECT 1;\nSELECT 2;', 3)).toEqual({ start: 0, end: 8 });
    expect(statementAtCaret('   ', 2)).toBeNull();
  });
});

describe('SqlEditor — run scope (R-3.2/R-3.6)', () => {
  it('sends the selection as mode:single when a text selection is present', () => {
    const onRun = vi.fn();
    renderWithChakra(
      <SqlEditor value="SELECT 1; SELECT 2;" onChange={() => {}} onRun={onRun} />,
    );
    const editor = screen.getByTestId('db-query-editor') as HTMLTextAreaElement;
    editor.selectionStart = 0;
    editor.selectionEnd = 8;

    fireEvent.click(screen.getByTestId('db-query-run'));

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith({ mode: 'single', selection: { start: 0, end: 8 } });
  });

  it('sends the statement at the caret as mode:single when there is no selection', () => {
    const onRun = vi.fn();
    renderWithChakra(
      <SqlEditor value={'SELECT 1;\nSELECT 2;'} onChange={() => {}} onRun={onRun} />,
    );
    const editor = screen.getByTestId('db-query-editor') as HTMLTextAreaElement;
    editor.selectionStart = 14;
    editor.selectionEnd = 14;

    fireEvent.click(screen.getByTestId('db-query-run'));

    expect(onRun).toHaveBeenCalledWith({ mode: 'single', selection: { start: 10, end: 18 } });
  });

  it('sends mode:all with no selection only from the explicit Run all action', () => {
    const onRun = vi.fn();
    renderWithChakra(<SqlEditor value="SELECT 1; SELECT 2;" onChange={() => {}} onRun={onRun} />);

    fireEvent.click(screen.getByTestId('db-query-run-all'));

    expect(onRun).toHaveBeenCalledWith({ mode: 'all', selection: null });
  });
});

describe('SqlEditor — typed errors (R-3.5)', () => {
  it('renders the message and the 1-based line/column when supplied', () => {
    const error: DbQueryError = {
      kind: 'query',
      message: 'syntax error at or near "SELEC"',
      line: 2,
      column: 5,
      position: 22,
    };
    renderWithChakra(
      <SqlEditor value={'SELECT 1;\nSELEC 2;'} onChange={() => {}} onRun={() => {}} error={error} />,
    );

    expect(screen.getByTestId('db-query-error')).toHaveTextContent(
      'syntax error at or near "SELEC"',
    );
    expect(screen.getByTestId('db-query-error-position')).toHaveTextContent('line 2, column 5');
  });

  it('omits the position line when the server supplies none', () => {
    const error: DbQueryError = { kind: 'timeout', message: 'statement timed out' };
    renderWithChakra(
      <SqlEditor value="SELECT 1" onChange={() => {}} onRun={() => {}} error={error} />,
    );

    expect(screen.getByTestId('db-query-error')).toHaveTextContent('statement timed out');
    expect(screen.queryByTestId('db-query-error-position')).toBeNull();
  });
});

describe('SqlEditor — schema completion (R-3.9)', () => {
  it('offers schema-derived completions after a table-position keyword and accepts with Enter', () => {
    const onChange = vi.fn();
    renderWithChakra(<EditorHarness onChange={onChange} />);
    const editor = screen.getByTestId('db-query-editor') as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: 'SELECT * FROM ' } });

    expect(screen.getByTestId('db-autocomplete')).toBeDefined();
    expect(screen.getAllByTestId('db-autocomplete-option')).toHaveLength(2);

    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('SELECT * FROM orders');
  });

  it('filters completions by the typed token', () => {
    renderWithChakra(<EditorHarness />);
    const editor = screen.getByTestId('db-query-editor') as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: 'SELECT * FROM us' } });

    expect(screen.getAllByTestId('db-autocomplete-option')).toHaveLength(1);
    expect(screen.getByTestId('db-autocomplete-option')).toHaveTextContent('users');
  });
});
