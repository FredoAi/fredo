/**
 * Spec #3147 ST-6 — the settings pane's states and its absent-key render.
 * Spec #3146 — the consent section (`Extra permissions`).
 *
 * Pins the states UI/UX §3.1 fixes: loading (3 skeletons), empty (and the list
 * is NOT rendered), populated, refusal (with `data-refusal-code` + the copy
 * sentence), success, and `list-load-failed` (a verdict, never a blank pane and
 * never the empty state). Plus the two design-added hooks, the install button's
 * recovery after a refusal (R-3.5), and the absent-key wire shape (G-413).
 *
 * The #3146 half pins the consent contract: one row per application / one control
 * line per declared high-risk capability, keyed by `{appId, capability}`; a grant
 * that is CONFIRMED by the command's returned status (never optimistic); a grant
 * to one application never enabling another; an unrecognised capability shown
 * loudly with NO control; and the entry rows still carrying zero buttons.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type {
  CapabilityId,
  InstalledAppCapabilityStatus,
  InstalledAppEntry,
} from '@/shared/installed-apps/types';

const storeMock = vi.hoisted(() => ({
  refresh: vi.fn(),
  record: vi.fn(),
  status: {
    entries: [] as InstalledAppEntry[],
    loading: false,
    settled: true,
    error: null as { code: string; detail: string } | null,
  },
}));

const clientMock = vi.hoisted(() => ({
  install: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock('@/shared/installed-apps/store', () => ({
  refreshInstalledApps: () => storeMock.refresh(),
  recordInstalledApp: (entry: InstalledAppEntry) => storeMock.record(entry),
}));

vi.mock('@/shared/installed-apps/useInstalledApps', () => ({
  useInstalledAppsStatus: () => storeMock.status,
}));

vi.mock('@/shared/installed-apps/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/installed-apps/client')>();
  return {
    ...actual,
    installPackage: (...args: unknown[]) => clientMock.install(...args),
    grantCapabilityConsent: (...args: unknown[]) => clientMock.grant(...args),
    revokeCapabilityConsent: (...args: unknown[]) => clientMock.revoke(...args),
  };
});

import {
  InstalledAppsSettings,
  ALLOW_BUTTON_TEXT,
  CONSENT_BLOCKED_LINE,
  CONSENT_ENABLED_LINE,
  CONSENT_SCOPE_LINE,
  CONSENT_SECTION_HEADING,
  CONSENT_SECTION_INTRO,
  CONSENT_STATE_ALLOWED,
  CONSENT_STATE_NOT_ALLOWED,
  EMPTY_HEADLINE,
  EMPTY_NEXT_ACTION,
  INSTALL_BUTTON_LABEL,
  LIMITATIONS_HEADING,
  LIMITATIONS_SENTENCE,
  REVOKE_BUTTON_TEXT,
  UNKNOWN_CAPABILITY_LINE,
  UNSIGNED_PACKAGE_NOTE,
  allowConsentLabel,
  revokeConsentLabel,
} from '../InstalledAppsSettings';
import { CAPABILITY_CONSENT_COPY } from '@/shared/installed-apps/capabilityRefusals';
import { INSTALL_REFUSAL_COPY } from '@/shared/installed-apps/refusals';

/** No declared reach — the fail-safe projection the backend always emits. */
function noCapabilities(appId: string): InstalledAppCapabilityStatus {
  return { appId, declared: [], highRisk: [], consented: [] };
}

const ENTRY: InstalledAppEntry = {
  id: 'dev.example.tools',
  displayName: 'Example Tools',
  version: '1.2.0',
  enginesFredo: '^0.1.0',
  installedAt: '2026-01-01T00:00:00Z',
  windowLabel: 'installed-dev.example.tools',
  description: 'A helpful tool.',
  capabilities: noCapabilities('dev.example.tools'),
};

const CAP_QUERY = 'high-risk.database-query';
const CAP_RESET = 'high-risk.database-reset';

/** An application declaring two high-risk capabilities. */
function declaredEntry(id = 'qa3146-app-a', displayName = 'QA3146 App A'): InstalledAppEntry {
  return {
    id,
    displayName,
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    installedAt: '2026-01-01T00:00:00Z',
    windowLabel: `installed-${id}`,
    capabilities: {
      appId: id,
      declared: ['high-risk.database-query', 'high-risk.database-reset'],
      highRisk: ['high-risk.database-query', 'high-risk.database-reset'],
      consented: [],
    },
  };
}

/** The status a grant/revoke command returns for one consented pair. */
function consentedStatus(appId: string, capability: CapabilityId): InstalledAppCapabilityStatus {
  return {
    appId,
    declared: ['high-risk.database-query', 'high-risk.database-reset'],
    highRisk: ['high-risk.database-query', 'high-risk.database-reset'],
    consented: [capability],
  };
}

/**
 * Find a consent control by BOTH identity attributes.
 *
 * Selecting by position can grant the wrong capability — the single worst
 * outcome this surface can produce — so every click goes through both keys.
 */
function consentControl(
  kind: 'grant' | 'revoke',
  capability: string,
  appId: string,
): HTMLElement {
  const testId = `installed-apps-consent-${kind}`;
  const match = screen
    .queryAllByTestId(testId)
    .find(
      (candidate) =>
        candidate.getAttribute('data-capability') === capability &&
        candidate.getAttribute('data-app-id') === appId,
    );
  if (!match) throw new Error(`no ${testId} for ${appId} / ${capability}`);
  return match;
}

function consentRow(appId: string): HTMLElement {
  const row = screen
    .queryAllByTestId('installed-apps-consent-row')
    .find((candidate) => candidate.getAttribute('data-app-id') === appId);
  if (!row) throw new Error(`no consent row for ${appId}`);
  return row;
}

beforeEach(() => {
  storeMock.refresh = vi.fn(async () => {});
  storeMock.record = vi.fn();
  storeMock.status = { entries: [], loading: false, settled: true, error: null };
  clientMock.install = vi.fn();
  clientMock.grant = vi.fn();
  clientMock.revoke = vi.fn();
});

afterEach(cleanup);

describe('#3147 ST-6 — InstalledAppsSettings anatomy', () => {
  it('renders the header, the trust note, the install button and the limitations block', () => {
    renderWithChakra(<InstalledAppsSettings />);

    expect(screen.getByTestId('installed-apps-pane')).toBeInTheDocument();
    const button = screen.getByTestId('installed-apps-install-button');
    // The visible label IS the accessible name — three ASCII dots, no aria-label.
    expect(button).toHaveTextContent(INSTALL_BUTTON_LABEL);
    expect(button.getAttribute('aria-label')).toBeNull();

    expect(screen.getByText(UNSIGNED_PACKAGE_NOTE)).toBeInTheDocument();

    const limitations = screen.getByTestId('installed-apps-limitations');
    expect(limitations).toHaveTextContent(LIMITATIONS_HEADING);
    expect(limitations).toHaveTextContent(LIMITATIONS_SENTENCE);
    // Not a tab stop.
    expect(limitations.getAttribute('tabindex')).toBeNull();
  });

  it('asks the registry for the list on mount (nothing reads at startup)', () => {
    renderWithChakra(<InstalledAppsSettings />);
    expect(storeMock.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('#3147 ST-6 — InstalledAppsSettings states', () => {
  it('loading: renders three skeleton rows, no list and no empty state', () => {
    storeMock.status = { entries: [], loading: true, settled: false, error: null };
    renderWithChakra(<InstalledAppsSettings />);

    expect(screen.getByTestId('installed-apps-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('installed-apps-list')).toBeNull();
    expect(screen.queryByTestId('installed-apps-empty')).toBeNull();
  });

  it('empty: renders the empty state (role=status) and does NOT render the list', () => {
    renderWithChakra(<InstalledAppsSettings />);

    const empty = screen.getByTestId('installed-apps-empty');
    expect(empty).toHaveAttribute('role', 'status');
    expect(empty).toHaveTextContent(EMPTY_HEADLINE);
    expect(empty).toHaveTextContent(EMPTY_NEXT_ACTION);
    expect(empty.getAttribute('tabindex')).toBeNull();
    // The absence rule: never an empty <ul> beside an empty message.
    expect(screen.queryByTestId('installed-apps-list')).toBeNull();
  });

  it('populated: renders a read-only list with no Open/Remove control', () => {
    storeMock.status = { entries: [ENTRY], loading: false, settled: true, error: null };
    renderWithChakra(<InstalledAppsSettings />);

    const list = screen.getByTestId('installed-apps-list');
    expect(list).toHaveAttribute('role', 'list');

    const row = screen.getByTestId('installed-apps-entry');
    expect(row).toHaveAttribute('data-app-id', ENTRY.id);
    expect(row).toHaveTextContent(ENTRY.displayName);
    expect(row).toHaveTextContent(ENTRY.version);

    // Read-only: no button inside the row (one open surface, in the launcher).
    expect(row.querySelectorAll('button')).toHaveLength(0);
    expect(screen.queryByTestId('installed-apps-empty')).toBeNull();
  });

  it('absent description key: renders no description line and leaks no undefined/null (G-413)', () => {
    // The REAL wire shape: `description` is an ABSENT KEY when the manifest
    // omitted one — never `null`, never `undefined`.
    const wireShape = {
      id: 'no.desc',
      displayName: 'No Description App',
      version: '0.1.0',
      enginesFredo: '^0.1.0',
      installedAt: '2026-01-02T00:00:00Z',
      windowLabel: 'installed-no.desc',
      capabilities: noCapabilities('no.desc'),
    } as InstalledAppEntry;
    expect('description' in wireShape).toBe(false);

    storeMock.status = { entries: [wireShape], loading: false, settled: true, error: null };
    const { container } = renderWithChakra(<InstalledAppsSettings />);

    const row = screen.getByTestId('installed-apps-entry');
    expect(row).toHaveTextContent('No Description App');
    // No `undefined`/`null` leaked into the rendered row.
    expect(row.textContent ?? '').not.toMatch(/undefined|null/);
    expect(container.textContent ?? '').not.toMatch(/undefined|NaN/);
  });

  it('list-load-failed: renders the refusal with io_error, never the empty state', () => {
    storeMock.status = {
      entries: [],
      loading: false,
      settled: true,
      error: { code: 'io_error', detail: 'the registry could not be read' },
    };
    renderWithChakra(<InstalledAppsSettings />);

    const refusal = screen.getByTestId('installed-apps-refusal');
    expect(refusal).toHaveAttribute('role', 'alert');
    expect(refusal).toHaveAttribute('data-refusal-code', 'io_error');
    expect(screen.getByTestId('installed-apps-refusal-reason')).toHaveTextContent(
      INSTALL_REFUSAL_COPY.io_error,
    );
    // A failed read is a verdict, NOT the empty state.
    expect(screen.queryByTestId('installed-apps-empty')).toBeNull();
    expect(screen.queryByTestId('installed-apps-list')).toBeNull();
  });
});

describe('#3147 ST-6 — install verdicts (R-3.5 recovery)', () => {
  it('refusal: renders data-refusal-code + the copy sentence and re-enables the button', async () => {
    clientMock.install = vi.fn(async () => {
      throw { code: 'no_manifest', detail: 'no fredo-app.json at the archive root' };
    });
    renderWithChakra(<InstalledAppsSettings />);

    fireEvent.click(screen.getByTestId('installed-apps-install-button'));

    const refusal = await screen.findByTestId('installed-apps-refusal');
    expect(refusal).toHaveAttribute('data-refusal-code', 'no_manifest');
    expect(screen.getByTestId('installed-apps-refusal-reason')).toHaveTextContent(
      INSTALL_REFUSAL_COPY.no_manifest,
    );

    // R-3.5: the install surface is never left wedged.
    await waitFor(() => {
      expect(screen.getByTestId('installed-apps-install-button')).not.toBeDisabled();
    });
  });

  it('success: records the entry and renders the polite success strip', async () => {
    clientMock.install = vi.fn(async () => ENTRY);
    renderWithChakra(<InstalledAppsSettings />);

    fireEvent.click(screen.getByTestId('installed-apps-install-button'));

    const success = await screen.findByTestId('installed-apps-install-success');
    expect(success).toHaveAttribute('role', 'status');
    expect(success).toHaveAttribute('aria-live', 'polite');
    expect(success).toHaveTextContent(`${ENTRY.displayName} is installed.`);
    expect(storeMock.record).toHaveBeenCalledWith(ENTRY);
    expect(screen.queryByTestId('installed-apps-refusal')).toBeNull();
  });
});

// ── Spec #3146 — the consent section ────────────────────────────────────────

describe('#3146 — consent section presence (S0 / S6 / S7)', () => {
  it('S0: no application declares a high-risk capability ⇒ the section is absent, not empty', () => {
    storeMock.status = { entries: [ENTRY], loading: false, settled: true, error: null };
    renderWithChakra(<InstalledAppsSettings />);

    expect(screen.queryByTestId('installed-apps-consent-section')).toBeNull();
    expect(screen.queryByTestId('installed-apps-consent-row')).toBeNull();
    // The pane is otherwise fully rendered — the absence is a claim about the
    // declaration, not a failure to render.
    expect(screen.getByTestId('installed-apps-list')).toBeInTheDocument();
    // No tab stop added either.
    expect(screen.getByTestId('installed-apps-limitations').getAttribute('tabindex')).toBeNull();
  });

  it('S6: before the first read settles the section is absent (three states, never conflated)', () => {
    storeMock.status = {
      entries: [declaredEntry()],
      loading: true,
      settled: false,
      error: null,
    };
    renderWithChakra(<InstalledAppsSettings />);

    expect(screen.queryByTestId('installed-apps-consent-section')).toBeNull();
    expect(screen.getByTestId('installed-apps-loading')).toBeInTheDocument();
  });

  it('S7: a failed list read keeps describing the same snapshot the list still shows', () => {
    storeMock.status = {
      entries: [declaredEntry()],
      loading: false,
      settled: true,
      error: { code: 'io_error', detail: 'the registry could not be read' },
    };
    renderWithChakra(<InstalledAppsSettings />);

    // The list renders the kept snapshot, so the section MUST describe it too —
    // a list with no section beside it would read as "none of these ask for
    // anything", a false claim.
    expect(screen.getByTestId('installed-apps-list')).toBeInTheDocument();
    expect(screen.getByTestId('installed-apps-consent-section')).toBeInTheDocument();
    expect(screen.getByTestId('installed-apps-consent-row')).toHaveAttribute(
      'data-app-id',
      'qa3146-app-a',
    );
  });

  it('renders its own section, outside every entry row (the zero-button pin survives)', () => {
    storeMock.status = { entries: [declaredEntry()], loading: false, settled: true, error: null };
    renderWithChakra(<InstalledAppsSettings />);

    const section = screen.getByTestId('installed-apps-consent-section');
    expect(section.tagName).toBe('SECTION');
    expect(section).toHaveAttribute('aria-labelledby', 'installed-apps-consent-heading');
    expect(section).toHaveTextContent(CONSENT_SECTION_HEADING);
    expect(section).toHaveTextContent(CONSENT_SECTION_INTRO);
    expect(section).toHaveTextContent(CONSENT_SCOPE_LINE);

    const entryRow = screen.getByTestId('installed-apps-entry');
    expect(entryRow).not.toContainElement(section);
    expect(entryRow.querySelectorAll('button')).toHaveLength(0);
    expect(section.contains(entryRow)).toBe(false);
  });
});

describe('#3146 — one control line per declared capability', () => {
  it('renders a control per capability, each keyed by {appId, capability}', () => {
    storeMock.status = { entries: [declaredEntry()], loading: false, settled: true, error: null };
    renderWithChakra(<InstalledAppsSettings />);

    const row = consentRow('qa3146-app-a');
    expect(row).toHaveTextContent('QA3146 App A');
    expect(row).toHaveTextContent('qa3146-app-a');
    expect(row).toHaveAttribute('data-consent-state', 'not-allowed');

    // Exactly one control line per declared high-risk capability.
    const grants = within(row).getAllByTestId('installed-apps-consent-grant');
    expect(grants).toHaveLength(2);
    expect(grants.map((control) => control.getAttribute('data-capability')).sort()).toEqual([
      CAP_QUERY,
      CAP_RESET,
    ]);
    for (const control of grants) {
      expect(control).toHaveAttribute('data-app-id', 'qa3146-app-a');
      expect(control).toHaveTextContent(ALLOW_BUTTON_TEXT);
    }

    // The consequence sentence is the authored one, verbatim, per capability.
    expect(row).toHaveTextContent(CAPABILITY_CONSENT_COPY['high-risk.database-query'].consequence);
    expect(row).toHaveTextContent(CAPABILITY_CONSENT_COPY['high-risk.database-reset'].consequence);
    // The exact capability ids are readable before any click.
    expect(row).toHaveTextContent(CAP_QUERY);
    expect(row).toHaveTextContent(CAP_RESET);
    // Default state is neutral and named in words, never by colour alone.
    expect(within(row).getAllByText(CONSENT_STATE_NOT_ALLOWED)).toHaveLength(2);
    expect(row).toHaveTextContent(CONSENT_BLOCKED_LINE);
  });

  it('accessible names carry the application and the consequence (label in name)', () => {
    storeMock.status = { entries: [declaredEntry()], loading: false, settled: true, error: null };
    renderWithChakra(<InstalledAppsSettings />);

    const queryControl = consentControl('grant', CAP_QUERY, 'qa3146-app-a');
    expect(queryControl.getAttribute('aria-label')).toBe(
      allowConsentLabel('QA3146 App A', CAPABILITY_CONSENT_COPY['high-risk.database-query'].verb),
    );
    expect(queryControl.getAttribute('aria-label')).toContain(ALLOW_BUTTON_TEXT);
    expect(queryControl.getAttribute('aria-label')).toContain('QA3146 App A');

    // Not colour-only: the state word is text, and the line is announced politely.
    const row = consentRow('qa3146-app-a');
    const liveLines = within(row)
      .getAllByRole('status')
      .filter((node) => node.getAttribute('aria-live') === 'polite');
    expect(liveLines).toHaveLength(2);
    expect(row.querySelector('[aria-live="assertive"]')).toBeNull();
  });

  it('S8: an unrecognised high-risk id is shown loudly with NO control', () => {
    const unknownId = 'high-risk.everything' as unknown as CapabilityId;
    const entry: InstalledAppEntry = {
      ...declaredEntry('qa3146-future-host'),
      capabilities: {
        appId: 'qa3146-future-host',
        declared: [unknownId],
        highRisk: [unknownId],
        consented: [],
      },
    };
    storeMock.status = { entries: [entry], loading: false, settled: true, error: null };
    renderWithChakra(<InstalledAppsSettings />);

    const row = consentRow('qa3146-future-host');
    expect(row).toHaveTextContent(UNKNOWN_CAPABILITY_LINE);
    // The raw id is shown — never filtered away.
    expect(row).toHaveTextContent(unknownId);
    expect(within(row).getByText(CONSENT_STATE_NOT_ALLOWED)).toBeInTheDocument();
    // No control: Fredo cannot honestly ask for a scope it cannot read.
    expect(row.querySelectorAll('button')).toHaveLength(0);
    expect(screen.queryByTestId('installed-apps-consent-grant')).toBeNull();
    expect(screen.queryByTestId('installed-apps-consent-revoke')).toBeNull();
  });
});

describe('#3146 — grant / revoke is confirmed, never optimistic', () => {
  it('grant flips ONLY that pair, from the command\u2019s returned status', async () => {
    storeMock.status = { entries: [declaredEntry()], loading: false, settled: true, error: null };
    clientMock.grant = vi.fn(async (appId: string, capability: CapabilityId) =>
      consentedStatus(appId, capability),
    );
    renderWithChakra(<InstalledAppsSettings />);

    fireEvent.click(consentControl('grant', CAP_QUERY, 'qa3146-app-a'));

    const revoke = await screen.findByTestId('installed-apps-consent-revoke');
    expect(revoke).toHaveAttribute('data-app-id', 'qa3146-app-a');
    expect(revoke).toHaveAttribute('data-capability', CAP_QUERY);
    expect(revoke).toHaveTextContent(REVOKE_BUTTON_TEXT);
    expect(clientMock.grant).toHaveBeenCalledWith('qa3146-app-a', CAP_QUERY);

    // The OTHER pair is untouched — the pair, not the row, is the unit.
    expect(consentControl('grant', CAP_RESET, 'qa3146-app-a')).toHaveTextContent(ALLOW_BUTTON_TEXT);

    const row = consentRow('qa3146-app-a');
    expect(within(row).getByText(CONSENT_STATE_ALLOWED)).toBeInTheDocument();
    expect(within(row).getByText(CONSENT_STATE_NOT_ALLOWED)).toBeInTheDocument();
    expect(row).toHaveTextContent(CONSENT_ENABLED_LINE);
    // No reconcile read: the list is not re-fetched after a write.
    expect(storeMock.refresh).toHaveBeenCalledTimes(1);
  });

  it('the chip stays Not allowed until the host write settles (Doherty via loading, not optimism)', async () => {
    storeMock.status = { entries: [declaredEntry()], loading: false, settled: true, error: null };

    let settle: (status: InstalledAppCapabilityStatus) => void = () => {};
    clientMock.grant = vi.fn(
      () =>
        new Promise<InstalledAppCapabilityStatus>((resolve) => {
          settle = resolve;
        }),
    );

    renderWithChakra(<InstalledAppsSettings />);
    const control = consentControl('grant', CAP_QUERY, 'qa3146-app-a');
    fireEvent.click(control);

    // Synchronous acknowledgement on THIS control only.
    await waitFor(() => expect(consentControl('grant', CAP_QUERY, 'qa3146-app-a')).toBeDisabled());
    // …and the security claim is NOT painted early.
    expect(within(consentRow('qa3146-app-a')).getAllByText(CONSENT_STATE_NOT_ALLOWED)).toHaveLength(
      2,
    );
    expect(screen.queryByTestId('installed-apps-consent-revoke')).toBeNull();
    // Every OTHER control stays live during the write.
    expect(consentControl('grant', CAP_RESET, 'qa3146-app-a')).not.toBeDisabled();

    settle(consentedStatus('qa3146-app-a', CAP_QUERY));

    await waitFor(() => {
      expect(consentControl('revoke', CAP_QUERY, 'qa3146-app-a')).toBeInTheDocument();
    });
    expect(within(consentRow('qa3146-app-a')).getByText(CONSENT_STATE_ALLOWED)).toBeInTheDocument();
  });

  it('a grant to one application never enables another (per-application consent)', async () => {
    storeMock.status = {
      entries: [declaredEntry('qa3146-app-a'), declaredEntry('qa3146-app-b', 'QA3146 App B')],
      loading: false,
      settled: true,
      error: null,
    };
    clientMock.grant = vi.fn(async (appId: string, capability: CapabilityId) =>
      consentedStatus(appId, capability),
    );
    renderWithChakra(<InstalledAppsSettings />);

    expect(screen.getAllByTestId('installed-apps-consent-row')).toHaveLength(2);
    fireEvent.click(consentControl('grant', CAP_QUERY, 'qa3146-app-a'));

    await waitFor(() => {
      expect(consentControl('revoke', CAP_QUERY, 'qa3146-app-a')).toBeInTheDocument();
    });

    // B declares the identical capability and stays refused on BOTH pairs.
    const rowB = consentRow('qa3146-app-b');
    expect(within(rowB).getAllByTestId('installed-apps-consent-grant')).toHaveLength(2);
    expect(rowB).toHaveAttribute('data-consent-state', 'not-allowed');
    expect(within(rowB).queryByText(CONSENT_STATE_ALLOWED)).toBeNull();
  });

  it('S4: a revoke returns the pair to the ordinary not-allowed state, with no extra chrome', async () => {
    const consentedEntry = declaredEntry();
    consentedEntry.capabilities = {
      ...consentedEntry.capabilities,
      consented: [CAP_QUERY],
    };
    storeMock.status = {
      entries: [consentedEntry],
      loading: false,
      settled: true,
      error: null,
    };
    clientMock.revoke = vi.fn(async (appId: string) => ({
      ...consentedStatus(appId, CAP_QUERY),
      consented: [],
    }));

    renderWithChakra(<InstalledAppsSettings />);
    expect(consentControl('revoke', CAP_QUERY, 'qa3146-app-a')).toBeInTheDocument();

    fireEvent.click(consentControl('revoke', CAP_QUERY, 'qa3146-app-a'));

    await waitFor(() => {
      expect(consentControl('grant', CAP_QUERY, 'qa3146-app-a')).toBeInTheDocument();
    });
    expect(clientMock.revoke).toHaveBeenCalledWith('qa3146-app-a', CAP_QUERY);

    const row = consentRow('qa3146-app-a');
    expect(within(row).getAllByText(CONSENT_STATE_NOT_ALLOWED)).toHaveLength(2);
    expect(row).toHaveTextContent(CONSENT_BLOCKED_LINE);
    // The state IS S1 — no sticky "revoked" badge, one fact one representation.
    expect(row.textContent ?? '').not.toMatch(/revoked/i);
  });

  it('S5: a refused command renders its own alert, changes no state, and re-enables the control', async () => {
    storeMock.status = { entries: [declaredEntry()], loading: false, settled: true, error: null };
    clientMock.grant = vi.fn(async () => {
      throw {
        code: 'manifest_invalid_field',
        detail: 'not a high-risk capability this application declared',
        field: 'capability',
      };
    });

    renderWithChakra(<InstalledAppsSettings />);
    fireEvent.click(consentControl('grant', CAP_QUERY, 'qa3146-app-a'));

    const refusal = await screen.findByTestId('installed-apps-consent-refusal');
    expect(refusal).toHaveAttribute('role', 'alert');
    expect(refusal).toHaveAttribute('data-refusal-code', 'manifest_invalid_field');
    expect(refusal).toHaveTextContent(INSTALL_REFUSAL_COPY.manifest_invalid_field);
    // The mono field chip, and the host's detail beside the sentence.
    const fieldChip = Array.from(refusal.querySelectorAll('span')).find(
      (node) => node.textContent?.trim() === 'capability',
    );
    expect(fieldChip).toBeDefined();
    expect(refusal).toHaveTextContent('not a high-risk capability this application declared');

    // Nothing was painted optimistically, so the row is unchanged.
    const row = consentRow('qa3146-app-a');
    expect(row).toHaveAttribute('data-consent-state', 'not-allowed');
    expect(within(row).getAllByText(CONSENT_STATE_NOT_ALLOWED)).toHaveLength(2);

    // Every control is live again.
    await waitFor(() =>
      expect(consentControl('grant', CAP_QUERY, 'qa3146-app-a')).not.toBeDisabled(),
    );

    // The refusal is the section's, not the install verdict slot's.
    expect(screen.queryByTestId('installed-apps-refusal')).toBeNull();
  });
});

