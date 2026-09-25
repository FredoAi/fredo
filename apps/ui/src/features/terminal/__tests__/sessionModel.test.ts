import { describe, expect, it } from 'vitest';
import {
  CLI_LABEL,
  displayWorkDir,
  errorStateMeta,
  lastActiveLabel,
  normalizeKind,
  persistedAriaLabel,
  resumeBlockedReason,
  sessionAriaLabel,
  sessionDisplayTitle,
  sessionTitle,
  sortPersistedSessions,
  type PersistedTerminalSession,
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

describe('Spec 2934 ST-3 — sessionModel (titles, paths, typed error states)', () => {
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

  it('normalizes a stored default kind safely (absent/corrupt → Terminal)', () => {
    // Spec #2942 AC3 edge — absent or unrecognized → the plain-shell default.
    expect(normalizeKind('shell')).toBe('shell');
    expect(normalizeKind('copilot')).toBe('copilot');
    expect(normalizeKind('opencode')).toBe('opencode');
    expect(normalizeKind('corrupt')).toBe('shell');
    expect(normalizeKind(null)).toBe('shell');
    expect(normalizeKind(undefined)).toBe('shell');
  });

  it('titles a shell session with the Terminal label (Spec #2942)', () => {
    const s = session({ id: 's', cli: 'shell' });
    expect(CLI_LABEL.shell).toBe('Terminal');
    expect(sessionTitle(s, [s])).toBe('Terminal');
    expect(sessionAriaLabel(s, [s])).toBe('Terminal, Terminal, running');
  });

  it('adds the shell ordinal only when more than one Terminal-type session exists', () => {
    const a = session({ id: 'a', cli: 'shell' });
    const b = session({ id: 'b', cli: 'shell' });
    expect(sessionTitle(a, [a, b])).toBe('Terminal 1');
    expect(sessionTitle(b, [a, b])).toBe('Terminal 2');
  });

  it('maps a missing shell binary to a shell-specific state', () => {
    const meta = errorStateMeta(session({ errorKind: 'missing-binary', cli: 'shell' }));
    expect(meta.title).toBe('No shell found');
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

  it('maps an unknown CLI to the invalid-cli state (AC4) instead of a generic error', () => {
    const meta = errorStateMeta(
      session({ errorKind: 'invalid-cli', error: "'bogus' is not a known CLI." }),
    );
    expect(meta.title).toBe('Unknown CLI');
    // The offending value is surfaced from the raw message — never parsed.
    expect(meta.showRawMessage).toBe(true);
    expect(meta.actions).toEqual(['close']);
  });
});

describe('Spec 2935 ST-4 — persisted records + resume contract', () => {
  function record(overrides: Partial<PersistedTerminalSession>): PersistedTerminalSession {
    return {
      id: 'p1',
      cli: 'opencode',
      workDir: 'C:\\Code\\fredo',
      title: 'OpenCode',
      createdAt: 1,
      lastActiveAt: Date.now(),
      cliSessionId: null,
      ...overrides,
    };
  }

  it('formats the relative last-active cell and falls back safely', () => {
    const now = 1_700_000_000_000;
    expect(lastActiveLabel(now - 5_000, now)).toBe('just now');
    expect(lastActiveLabel(now - 12 * 60_000, now)).toBe('12m ago');
    expect(lastActiveLabel(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(lastActiveLabel(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(lastActiveLabel(now - 30 * 86_400_000, now)).toBe(
      new Date(now - 30 * 86_400_000).toLocaleDateString(),
    );
    expect(lastActiveLabel(0, now)).toBe('unknown');
    expect(lastActiveLabel(Number.NaN, now)).toBe('unknown');
  });

  it('maps resume outcomes onto the renderable blocked reasons (no transcript-missing)', () => {
    expect(resumeBlockedReason('missing-binary')).toBe('cli-missing');
    expect(resumeBlockedReason('invalid-cwd')).toBe('invalid-cwd');
    expect(resumeBlockedReason('unresumable')).toBe('resume-failed');
    expect(resumeBlockedReason('launch-failed')).toBe('resume-failed');
    expect(resumeBlockedReason('resumed')).toBeNull();
  });

  it('composes the previous-row aria-label as title, CLI, state, relative last-active', () => {
    const now = 1_700_000_000_000;
    const r = record({ title: 'OpenCode 2', cli: 'copilot', lastActiveAt: now - 3 * 3_600_000 });
    expect(persistedAriaLabel(r, 'resumable', now)).toBe(
      'OpenCode 2, GitHub Copilot, not running, last active 3h ago',
    );
    expect(persistedAriaLabel(r, 'unresumable', now)).toContain("can't resume");
  });

  it('orders persisted records newest-first (the zero-click Resume selection)', () => {
    const a = record({ id: 'a', lastActiveAt: 100 });
    const b = record({ id: 'b', lastActiveAt: 900 });
    const c = record({ id: 'c', lastActiveAt: 500 });
    expect(sortPersistedSessions([a, b, c]).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('Spec 2942 ST-3 — sessionDisplayTitle (the record title is the name)', () => {
  function record(overrides: Partial<PersistedTerminalSession>): PersistedTerminalSession {
    return {
      id: 'p1',
      cli: 'opencode',
      workDir: 'C:\\Code\\fredo',
      title: 'OpenCode',
      createdAt: 1,
      lastActiveAt: 1,
      cliSessionId: null,
      ...overrides,
    };
  }

  it('resolves the persisted record title over the derived ordinal title', () => {
    const a = session({ id: 'a', cli: 'opencode' });
    const b = session({ id: 'b', cli: 'opencode' });
    const sessions = [a, b];
    // In a two-OpenCode window the derived title for `a` would be "OpenCode 1".
    expect(sessionTitle(a, sessions)).toBe('OpenCode 1');

    const map = new Map([['a', record({ id: 'a', title: 'Build agent' })]]);
    expect(sessionDisplayTitle(a, sessions, map)).toBe('Build agent');
    // A record-less row (a failed spawn never persists a record) keeps the
    // derived title — it cannot carry a user-set name.
    expect(sessionDisplayTitle(b, sessions, map)).toBe('OpenCode 2');
  });

  it('resolves the live row and its previous-session row through ONE record map', () => {
    // `resume` REUSES the record's id, so the same id resolves both the live row
    // and the previous row — they can never disagree (one identity, one name).
    const live = session({ id: 'x', cli: 'opencode' });
    const map = new Map([['x', record({ id: 'x', title: 'My agent' })]]);
    expect(sessionDisplayTitle(live, [live], map)).toBe('My agent');
  });

  it('shows the renamed name after the record map updates (rename is one column)', () => {
    const live = session({ id: 'x', cli: 'opencode' });
    const before = new Map([['x', record({ id: 'x', title: 'OpenCode' })]]);
    const after = new Map([['x', record({ id: 'x', title: 'Deploy bot' })]]);
    expect(sessionDisplayTitle(live, [live], before)).toBe('OpenCode');
    expect(sessionDisplayTitle(live, [live], after)).toBe('Deploy bot');
  });
});
