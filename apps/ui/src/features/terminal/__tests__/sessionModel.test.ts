import { describe, expect, it } from 'vitest';
import {
  CLI_LABEL,
  displayWorkDir,
  errorStateMeta,
  normalizeCli,
  sessionAriaLabel,
  sessionTitle,
  type TerminalSessionInfo,
} from '../sessionModel';

function session(overrides: Partial<TerminalSessionInfo>): TerminalSessionInfo {
  return {
    id: 's1',
    cli: 'opencode',
    status: 'running',
    error: null,
    errorKind: null,
    workDir: 'C:\\Code\\fredo',
    cols: 80,
    rows: 24,
    pid: 1,
    startedAt: 1,
    ...overrides,
  };
}

describe('#2934 ST-3 — sessionModel (titles, paths, typed error states)', () => {
  it('titles a lone session with its CLI label and adds an ordinal only when >1 of that CLI', () => {
    const a = session({ id: 'a', cli: 'opencode' });
    const b = session({ id: 'b', cli: 'copilot' });
    const c = session({ id: 'c', cli: 'opencode' });
    const all = [a, b, c];

    expect(sessionTitle(a, all)).toBe('OpenCode 1');
    expect(sessionTitle(b, all)).toBe('GitHub Copilot');
    expect(sessionTitle(c, all)).toBe('OpenCode 2');
    expect(sessionTitle(a, [a])).toBe(CLI_LABEL.opencode);
  });

  it('composes the row aria-label as title, CLI, status', () => {
    const s = session({ status: 'starting', cli: 'copilot' });
    expect(sessionAriaLabel(s, [s])).toBe('GitHub Copilot, GitHub Copilot, starting');
  });

  it('shows the work-dir basename and `~` for the home/blank fallback', () => {
    expect(displayWorkDir('C:\\Code\\fredo')).toBe('fredo');
    expect(displayWorkDir('/home/me/project')).toBe('project');
    expect(displayWorkDir('')).toBe('~');
    expect(displayWorkDir('~')).toBe('~');
    expect(displayWorkDir('.')).toBe('~');
    expect(displayWorkDir(null)).toBe('~');
  });

  it('normalizes a stored default CLI safely (never invents copilot)', () => {
    expect(normalizeCli('copilot')).toBe('copilot');
    expect(normalizeCli('opencode')).toBe('opencode');
    expect(normalizeCli('corrupt')).toBe('opencode');
    expect(normalizeCli(null)).toBe('opencode');
    expect(normalizeCli(undefined)).toBe('opencode');
  });

  it('maps every typed error kind to its distinct state (missing binary names the CLI)', () => {
    expect(errorStateMeta(session({ errorKind: 'missing-binary', cli: 'opencode' })).title).toBe(
      'OpenCode not found',
    );
    expect(errorStateMeta(session({ errorKind: 'missing-binary', cli: 'copilot' })).title).toBe(
      'GitHub Copilot not found',
    );
    expect(errorStateMeta(session({ errorKind: 'prereq' })).title).toBe(
      'PowerShell 6 or newer required',
    );
    expect(errorStateMeta(session({ errorKind: 'invalid-cwd' })).title).toBe(
      'Working directory not found',
    );
    expect(errorStateMeta(session({ errorKind: 'auth' })).title).toBe(
      'Not signed in to GitHub Copilot',
    );
    expect(errorStateMeta(session({ errorKind: 'launch' })).title).toBe('Could not start session');
    expect(errorStateMeta(session({ errorKind: 'generic' })).title).toBe('Could not start session');
  });

  it('never derives a state from the free-form message (no regex path survives)', () => {
    // `not found in PATH` is the OLD regex trigger; with no typed kind (and even
    // with an explicit generic kind) it must NOT select the missing-binary state.
    const legacy = session({ errorKind: null, error: 'opencode not found in PATH' });
    expect(errorStateMeta(legacy).title).toBe('Could not start session');
    expect(errorStateMeta(legacy).showRawMessage).toBe(true);

    const generic = session({
      errorKind: 'generic',
      error: 'opencode not found in PATH',
    });
    expect(errorStateMeta(generic).title).toBe('Could not start session');
  });

  it('invalid-cwd names the offending path in the body', () => {
    const meta = errorStateMeta(
      session({ errorKind: 'invalid-cwd', workDir: 'C:\\NonexistentDir12345' }),
    );
    expect(meta.body).toContain('C:\\NonexistentDir12345');
    expect(meta.actions).toEqual(['choose-directory', 'close']);
  });

  it('the auth state offers Copy command + Retry + Close', () => {
    expect(errorStateMeta(session({ errorKind: 'auth' })).actions).toEqual([
      'copy-command',
      'retry',
      'close',
    ]);
  });
});
