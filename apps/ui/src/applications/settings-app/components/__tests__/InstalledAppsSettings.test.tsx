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
  replace: vi.fn(),
  forget: vi.fn(),
  status: {
    entries: [] as InstalledAppEntry[],
    loading: false,
    settled: true,
    error: null as { code: string; detail: string } | null,
  },
}));

const clientMock = vi.hoisted(() => ({
  install: vi.fn(),
  installDevelopment: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  disable: vi.fn(),
  enable: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/shared/installed-apps/store', () => ({
  refreshInstalledApps: () => storeMock.refresh(),
  recordInstalledApp: (entry: InstalledAppEntry) => storeMock.record(entry),
  replaceInstalledApp: (entry: InstalledAppEntry) => storeMock.replace(entry),
  forgetInstalledApp: (appId: string) => storeMock.forget(appId),
}));

vi.mock('@/shared/installed-apps/useInstalledApps', () => ({
  useInstalledAppsStatus: () => storeMock.status,
}));

vi.mock('@/shared/installed-apps/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/installed-apps/client')>();
  return {
    ...actual,
    installPackage: (...args: unknown[]) => clientMock.install(...args),
    installDevelopmentPackage: (...args: unknown[]) => clientMock.installDevelopment(...args),
    grantCapabilityConsent: (...args: unknown[]) => clientMock.grant(...args),
    revokeCapabilityConsent: (...args: unknown[]) => clientMock.revoke(...args),
    disableInstalledApp: (...args: unknown[]) => clientMock.disable(...args),
    enableInstalledApp: (...args: unknown[]) => clientMock.enable(...args),
    removeInstalledApp: (...args: unknown[]) => clientMock.remove(...args),
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
  DISABLED_HELPER_LINE,
  EMPTY_HEADLINE,
  EMPTY_NEXT_ACTION,
  GRANTS_EMPTY_LINE,
  HIGH_RISK_CLASS_TAG,
  INSTALL_BUTTON_LABEL,
  INSTALL_DEVELOPMENT_BUTTON_LABEL,
  LIMITATIONS_HEADING,
  LIMITATIONS_SENTENCE,
  MANAGEMENT_REFUSAL_COPY_OVERRIDES,
  NO_DESCRIPTION_MARKER,
  ORDINARY_CLASS_TAG,
  REVOKE_BUTTON_TEXT,
  STATE_LEGEND_LINE,
  STATE_WORDS,
  UNKNOWN_CAPABILITY_LINE,
  UNSIGNED_PACKAGE_NOTE,
  allowConsentLabel,
  removeLabel,
  revokeConsentLabel,
  turnOffLabel,
  turnOnLabel,
} from '../InstalledAppsSettings';
import {
  REMOVE_CANCEL_LABEL,
  REMOVE_CONFIRM_LABEL,
  removalDisclosureSentence,
} from '../RemoveInstalledAppDialog';
import { CAPABILITY_CONSENT_COPY, CAPABILITY_DECLARED_COPY } from '@/shared/installed-apps/capabilityRefusals';
import { installedAppFailureReason } from '@/shared/installed-apps/failureReasons';
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
  state: 'working',
  capabilities: noCapabilities('dev.example.tools'),
  mode: 'released',
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
    state: 'working',
    capabilities: {
      appId: id,
      declared: ['high-risk.database-query', 'high-risk.database-reset'],
      highRisk: ['high-risk.database-query', 'high-risk.database-reset'],
      consented: [],
    },
    mode: 'released',
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
  storeMock.replace = vi.fn();
  storeMock.forget = vi.fn();
  storeMock.status = { entries: [], loading: false, settled: true, error: null };
  clientMock.install = vi.fn();
  clientMock.installDevelopment = vi.fn();
  clientMock.grant = vi.fn();
  clientMock.revoke = vi.fn();
  clientMock.disable = vi.fn();
  clientMock.enable = vi.fn();
  clientMock.remove = vi.fn();
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

  it('populated: renders a list whose row carries its OWN controls — and no Open control', () => {
    storeMock.status = { entries: [ENTRY], loading: false, settled: true, error: null };
    renderWithChakra(<InstalledAppsSettings />);

    const list = screen.getByTestId('installed-apps-list');
    expect(list).toHaveAttribute('role', 'list');

    const row = screen.getByTestId('installed-apps-entry');
    expect(row).toHaveAttribute('data-app-id', ENTRY.id);
    expect(row).toHaveTextContent(ENTRY.displayName);
    expect(row).toHaveTextContent(ENTRY.version);

    // #3144 (G-374): the row now legitimately carries its OWN management controls
    // — exactly the ones its state warrants, and NO OTHER button. The pane is
    // still a registry view, so there is STILL no Open control.
    const controls = within(row).getAllByRole('button');
    expect(controls.map((control) => control.getAttribute('data-testid')).sort()).toEqual([
      'installed-apps-disable',
      'installed-apps-remove',
    ]);
    expect(within(row).queryByText(/open/i)).toBeNull();

    // The state is carried as TEXT (never colour alone).
    expect(row).toHaveAttribute('data-app-state', 'working');
    expect(within(row).getByTestId('installed-apps-entry-state')).toHaveTextContent(
      STATE_WORDS.working,
    );
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
      state: 'working',
      capabilities: noCapabilities('no.desc'),
      mode: 'released',
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
  it('S0 (RE-CUT — #3144, Adjudication 10.1): a zero-capability app still gets its OWN row, reading none + grants-empty', () => {
    storeMock.status = { entries: [ENTRY], loading: false, settled: true, error: null };
    renderWithChakra(<InstalledAppsSettings />);

    // Adjudication 10.1: the section renders when the list is settled and non-empty
    // (the older "render only when some app declares high-risk" gate is WITHDRAWN
    // — it left `installed-apps-grants-empty` unreachable). EVERY entry gets a row.
    const section = screen.getByTestId('installed-apps-consent-section');
    const row = consentRow(ENTRY.id);
    expect(section.contains(row)).toBe(true);
    expect(row).toHaveAttribute('data-consent-state', 'none');
    expect(within(row).getByTestId('installed-apps-grants-empty')).toHaveTextContent(
      GRANTS_EMPTY_LINE,
    );
    // No high-risk line for a zero-capability app.
    expect(row.querySelector('[data-capability-class="high-risk"]')).toBeNull();

    // The pane is otherwise fully rendered, and the legend is absent (legend is
    // per-list, not per-row).
    expect(screen.getByTestId('installed-apps-list')).toBeInTheDocument();
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

  it('renders its own section, outside every entry row — with the consent controls OUTSIDE the row (G-374 both directions)', () => {
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
    // The RE-CUT direction A: the old "zero buttons" pin is gone; the row carries
    // exactly its state's management controls and nothing else.
    expect(
      within(entryRow)
        .getAllByRole('button')
        .map((control) => control.getAttribute('data-testid'))
        .sort(),
    ).toEqual(['installed-apps-disable', 'installed-apps-remove']);
    // The RE-CUT direction B (the property the old pin protected): every
    // grant/revoke control still lives OUTSIDE every entry row.
    for (const control of screen.getAllByTestId('installed-apps-consent-grant')) {
      expect(control.closest('[data-testid="installed-apps-entry"]')).toBeNull();
    }
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

    // #3144 — every declared line is TAGGED high-risk and the tag is TEXT.
    const highRiskLines = row.querySelectorAll('[data-capability-class="high-risk"]');
    expect(highRiskLines).toHaveLength(2);
    expect(row.querySelectorAll('[data-capability-class="ordinary"]')).toHaveLength(0);
    expect(within(row).getAllByText(HIGH_RISK_CLASS_TAG)).toHaveLength(2);
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
    // It is still classified high-risk (the backend's own classification), so its
    // data-capability-class is high-risk even though its copy is unknown.
    expect(
      row.querySelector(`[data-capability="${unknownId}"]`)?.getAttribute('data-capability-class'),
    ).toBe('high-risk');
    expect(row).toHaveAttribute('data-consent-state', 'not-allowed');
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

// ── Spec #3144 — lifecycle state, management controls, the removal dialog ────

/** A minimal entry with a chosen state (empty capabilities unless overridden). */
function lifecycleEntry(over: Partial<InstalledAppEntry> = {}): InstalledAppEntry {
  return {
    id: 'qa3147-valid',
    displayName: 'QA3147 Valid',
    version: '1.0.0',
    enginesFredo: '>=0.0.0',
    installedAt: '2026-01-01T00:00:00Z',
    windowLabel: 'installed-qa3147-valid',
    state: 'working',
    capabilities: noCapabilities('qa3147-valid'),
    mode: 'released',
    ...over,
  };
}

describe('#3144 — the inventory state word, the legend and the failure line', () => {
  it('renders exactly one state WORD as text per row, agreeing with data-app-state', () => {
    storeMock.status = {
      entries: [
        lifecycleEntry({ id: 'a', displayName: 'A', state: 'working' }),
        lifecycleEntry({ id: 'b', displayName: 'B', state: 'failing', failureCode: 'io_error' }),
        lifecycleEntry({ id: 'c', displayName: 'C', state: 'disabled' }),
      ],
      loading: false,
      settled: true,
      error: null,
    };
    renderWithChakra(<InstalledAppsSettings />);

    const rows = screen.getAllByTestId('installed-apps-entry');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const state = row.getAttribute('data-app-state') ?? '';
      const word = STATE_WORDS[state as keyof typeof STATE_WORDS];
      const stateNode = within(row).getByTestId('installed-apps-entry-state');
      expect(stateNode).toHaveTextContent(word);
      expect(within(row).getAllByTestId('installed-apps-entry-state')).toHaveLength(1);
    }
  });

  it('renders the legend exactly once inside the inventory region, only when the list is non-empty', () => {
    storeMock.status = { entries: [lifecycleEntry()], loading: false, settled: true, error: null };
    renderWithChakra(<InstalledAppsSettings />);
    const legends = screen.getAllByTestId('installed-apps-state-legend');
    expect(legends).toHaveLength(1);
    expect(legends[0]).toHaveTextContent(STATE_LEGEND_LINE);

    cleanup();
    storeMock.status = { entries: [], loading: false, settled: true, error: null };
    renderWithChakra(<InstalledAppsSettings />);
    expect(screen.queryByTestId('installed-apps-state-legend')).toBeNull();
  });

  it('failure line: present iff failing, with the INVENTORY sentence + the witness code (never install copy)', () => {
    storeMock.status = {
      entries: [
        lifecycleEntry({ id: 'bad', state: 'failing', failureCode: 'integrity_record_corrupt' }),
        lifecycleEntry({ id: 'ok', state: 'working' }),
      ],
      loading: false,
      settled: true,
      error: null,
    };
    renderWithChakra(<InstalledAppsSettings />);

    const failure = screen.getByTestId('installed-apps-entry-failure');
    expect(failure).toHaveAttribute('data-failure-code', 'integrity_record_corrupt');
    expect(failure).toHaveTextContent(
      installedAppFailureReason('integrity_record_corrupt'),
    );
    // The install-time sentences NEVER render here (R-10.10's absence, quoted).
    expect(failure.textContent ?? '').not.toContain(INSTALL_REFUSAL_COPY.id_not_installed);
    expect(failure.textContent ?? '').not.toContain(INSTALL_REFUSAL_COPY.io_error);
    expect(screen.getAllByTestId('installed-apps-entry-failure')).toHaveLength(1);
  });

  it('a failing row carries its own turn-off + remove controls', () => {
    storeMock.status = {
      entries: [lifecycleEntry({ id: 'bad', state: 'failing', failureCode: 'io_error' })],
      loading: false,
      settled: true,
      error: null,
    };
    renderWithChakra(<InstalledAppsSettings />);
    const row = screen.getByTestId('installed-apps-entry');
    expect(
      within(row)
        .getAllByRole('button')
        .map((control) => control.getAttribute('data-testid'))
        .sort(),
    ).toEqual(['installed-apps-disable', 'installed-apps-remove']);
  });

  it('a disabled row swaps the toggle to enable and shows the honest disabled helper', () => {
    storeMock.status = {
      entries: [lifecycleEntry({ id: 'off', state: 'disabled' })],
      loading: false,
      settled: true,
      error: null,
    };
    renderWithChakra(<InstalledAppsSettings />);
    const row = screen.getByTestId('installed-apps-entry');
    expect(
      within(row)
        .getAllByRole('button')
        .map((control) => control.getAttribute('data-testid'))
        .sort(),
    ).toEqual(['installed-apps-enable', 'installed-apps-remove']);
    expect(row).toHaveTextContent(DISABLED_HELPER_LINE);
  });
});

describe('#3144 — the management controls and their accessible names (NFR-a11y)', () => {
  it('names the turn-off and remove controls with the application name', () => {
    storeMock.status = {
      entries: [lifecycleEntry({ id: 'ok', displayName: 'Ok App', state: 'working' })],
      loading: false,
      settled: true,
      error: null,
    };
    renderWithChakra(<InstalledAppsSettings />);
    expect(screen.getByTestId('installed-apps-disable')).toHaveAttribute(
      'aria-label',
      turnOffLabel('Ok App'),
    );
    expect(screen.getByTestId('installed-apps-remove')).toHaveAttribute(
      'aria-label',
      removeLabel('Ok App'),
    );
  });

  it('names the enable control with the application name', () => {
    storeMock.status = {
      entries: [lifecycleEntry({ id: 'off', displayName: 'Off App', state: 'disabled' })],
      loading: false,
      settled: true,
      error: null,
    };
    renderWithChakra(<InstalledAppsSettings />);
    expect(screen.getByTestId('installed-apps-enable')).toHaveAttribute(
      'aria-label',
      turnOnLabel('Off App'),
    );
  });

  it('turn off is CONFIRMED, not optimistic — the word holds until the host answers', async () => {
    storeMock.status = {
      entries: [lifecycleEntry({ id: 'ok', displayName: 'Ok App', state: 'working' })],
      loading: false,
      settled: true,
      error: null,
    };
    let settle: (entry: InstalledAppEntry) => void = () => {};
    clientMock.disable = vi.fn(
      () =>
        new Promise<InstalledAppEntry>((resolve) => {
          settle = resolve;
        }),
    );
    renderWithChakra(<InstalledAppsSettings />);

    fireEvent.click(screen.getByTestId('installed-apps-disable'));
    await waitFor(() => expect(screen.getByTestId('installed-apps-disable')).toBeDisabled());
    // Not painted early: the state is still the host's record.
    expect(screen.getByTestId('installed-apps-entry')).toHaveAttribute('data-app-state', 'working');
    // The other management control stays live.
    expect(screen.getByTestId('installed-apps-remove')).not.toBeDisabled();

    const disabled = lifecycleEntry({ id: 'ok', displayName: 'Ok App', state: 'disabled' });
    settle(disabled);
    await waitFor(() => expect(storeMock.replace).toHaveBeenCalledWith(disabled));
  });

  it('a disabled app is enabled through the swapped control (same DOM slot)', async () => {
    storeMock.status = {
      entries: [lifecycleEntry({ id: 'off', displayName: 'Off App', state: 'disabled' })],
      loading: false,
      settled: true,
      error: null,
    };
    const enabled = lifecycleEntry({ id: 'off', displayName: 'Off App', state: 'working' });
    clientMock.enable = vi.fn(async () => enabled);
    renderWithChakra(<InstalledAppsSettings />);

    fireEvent.click(screen.getByTestId('installed-apps-enable'));
    await waitFor(() => expect(clientMock.enable).toHaveBeenCalledWith('off'));
    await waitFor(() => expect(storeMock.replace).toHaveBeenCalledWith(enabled));
  });

  it('a refused action renders installed-apps-action-refusal and leaves every control live', async () => {
    storeMock.status = {
      entries: [lifecycleEntry({ id: 'ok', displayName: 'Ok App', state: 'working' })],
      loading: false,
      settled: true,
      error: null,
    };
    clientMock.disable = vi.fn(async () => {
      throw { code: 'io_error', detail: 'the write failed' };
    });
    renderWithChakra(<InstalledAppsSettings />);

    fireEvent.click(screen.getByTestId('installed-apps-disable'));

    const refusal = await screen.findByTestId('installed-apps-action-refusal');
    expect(refusal).toHaveAttribute('role', 'alert');
    expect(refusal).toHaveAttribute('data-refusal-code', 'io_error');
    // The honest management-context sentence — NOT the install-time one (R-10.10).
    expect(refusal).toHaveTextContent(MANAGEMENT_REFUSAL_COPY_OVERRIDES.io_error!);
    expect(refusal.textContent ?? '').not.toContain(INSTALL_REFUSAL_COPY.io_error);
    expect(refusal.textContent ?? '').not.toContain(INSTALL_REFUSAL_COPY.id_not_installed);
    // State unchanged, and nothing is left wedged (R-3.5 / F-9.19).
    expect(screen.getByTestId('installed-apps-entry')).toHaveAttribute('data-app-state', 'working');
    await waitFor(() => expect(screen.getByTestId('installed-apps-disable')).not.toBeDisabled());
    expect(screen.getByTestId('installed-apps-remove')).not.toBeDisabled();
  });

  it('an id_not_installed action refusal also never renders the install-time sentence', async () => {
    storeMock.status = {
      entries: [lifecycleEntry({ id: 'ok', displayName: 'Ok App', state: 'working' })],
      loading: false,
      settled: true,
      error: null,
    };
    clientMock.disable = vi.fn(async () => {
      throw { code: 'id_not_installed', detail: 'no such application' };
    });
    renderWithChakra(<InstalledAppsSettings />);

    fireEvent.click(screen.getByTestId('installed-apps-disable'));

    const refusal = await screen.findByTestId('installed-apps-action-refusal');
    expect(refusal).toHaveAttribute('data-refusal-code', 'id_not_installed');
    expect(refusal).toHaveTextContent(MANAGEMENT_REFUSAL_COPY_OVERRIDES.id_not_installed!);
    // The lie constraint (a) names: an "isn't installed any more" sentence must
    // NEVER render here (R-10.10 quotes it verbatim).
    expect(refusal.textContent ?? '').not.toContain(INSTALL_REFUSAL_COPY.id_not_installed);
  });
});

describe('#3144 — the removable dialog (AC-3)', () => {
  it('opens with the disclosure BEFORE any confirm; Cancel is the safe exit and removes nothing', async () => {
    const target = lifecycleEntry({ id: 'gone', displayName: 'Gone App' });
    storeMock.status = { entries: [target], loading: false, settled: true, error: null };
    renderWithChakra(<InstalledAppsSettings />);

    expect(screen.queryByTestId('installed-apps-remove-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('installed-apps-remove'));

    const dialog = await screen.findByTestId('installed-apps-remove-dialog');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'installed-apps-remove-dialog-heading');
    const disclosure = screen.getByTestId('installed-apps-remove-disclosure');
    expect(disclosure).toHaveTextContent(removalDisclosureSentence(target));
    // The disclosure states the data is KEPT, and nothing happens yet.
    expect(disclosure).toHaveTextContent('kept');
    expect(clientMock.remove).not.toHaveBeenCalled();
    expect(screen.getByTestId('installed-apps-remove-confirm')).toHaveTextContent(
      REMOVE_CONFIRM_LABEL,
    );
    expect(screen.getByTestId('installed-apps-remove-cancel')).toHaveTextContent(
      REMOVE_CANCEL_LABEL,
    );

    fireEvent.click(screen.getByTestId('installed-apps-remove-cancel'));
    await waitFor(() =>
      expect(screen.queryByTestId('installed-apps-remove-dialog')).toBeNull(),
    );
    expect(clientMock.remove).not.toHaveBeenCalled();
    expect(storeMock.forget).not.toHaveBeenCalled();
  });

  it('confirm runs the removal and drops the row from the store', async () => {
    const target = lifecycleEntry({ id: 'gone', displayName: 'Gone App' });
    storeMock.status = { entries: [target], loading: false, settled: true, error: null };
    clientMock.remove = vi.fn(async () => ({
      appId: 'gone',
      removed: true,
      dataKept: true,
      dataTables: [],
    }));
    renderWithChakra(<InstalledAppsSettings />);

    fireEvent.click(screen.getByTestId('installed-apps-remove'));
    await screen.findByTestId('installed-apps-remove-dialog');
    fireEvent.click(screen.getByTestId('installed-apps-remove-confirm'));

    await waitFor(() => expect(clientMock.remove).toHaveBeenCalledWith('gone'));
    await waitFor(() => expect(storeMock.forget).toHaveBeenCalledWith('gone'));
  });

  it('a removal refusal closes the dialog and reports in the ONE pane slot', async () => {
    const target = lifecycleEntry({ id: 'gone', displayName: 'Gone App' });
    storeMock.status = { entries: [target], loading: false, settled: true, error: null };
    clientMock.remove = vi.fn(async () => {
      throw { code: 'io_error', detail: 'a file is still open' };
    });
    renderWithChakra(<InstalledAppsSettings />);

    fireEvent.click(screen.getByTestId('installed-apps-remove'));
    await screen.findByTestId('installed-apps-remove-dialog');
    fireEvent.click(screen.getByTestId('installed-apps-remove-confirm'));

    const refusal = await screen.findByTestId('installed-apps-action-refusal');
    expect(refusal).toHaveAttribute('data-refusal-code', 'io_error');
    await waitFor(() =>
      expect(screen.queryByTestId('installed-apps-remove-dialog')).toBeNull(),
    );
    // No second refusal hook inside the dialog (G-266 — one owner per hook).
    expect(screen.queryByTestId('installed-apps-remove-dialog-refusal')).toBeNull();
    expect(storeMock.forget).not.toHaveBeenCalled();
  });
});

describe('#3144 — the removal disclosure sentence', () => {
  it('names the data treatment specifically and never hedges the keep', () => {
    const withTables = lifecycleEntry({
      id: 'a',
      displayName: 'With Tables',
      capabilities: {
        appId: 'a',
        declared: ['data.tables'],
        highRisk: [],
        consented: [],
      },
    });
    expect(removalDisclosureSentence(withTables)).toBe(
      'Removing With Tables removes it from Fredo and from the launcher. Its stored data is kept, in the tables it declared.',
    );

    const noTables = lifecycleEntry({ id: 'b', displayName: 'No Tables' });
    expect(removalDisclosureSentence(noTables)).toBe(
      'Removing No Tables removes it from Fredo and from the launcher. Nothing of its own is removed. Its stored data is kept.',
    );
  });
});

describe('#3144 — the widened grants section (all declared capabilities)', () => {
  function ordinaryEntry(id = 'qa3146-app-a', displayName = 'QA3146 App A'): InstalledAppEntry {
    return lifecycleEntry({
      id,
      displayName,
      capabilities: { appId: id, declared: ['data.tables'], highRisk: [], consented: [] },
    });
  }

  it('shows an ordinary line with NO control, tagged ordinary, and reads data-consent-state none', () => {
    storeMock.status = { entries: [ordinaryEntry()], loading: false, settled: true, error: null };
    renderWithChakra(<InstalledAppsSettings />);

    const row = consentRow('qa3146-app-a');
    expect(row).toHaveAttribute('data-consent-state', 'none');
    const line = row.querySelector('[data-capability="data.tables"]');
    expect(line).not.toBeNull();
    expect(line).toHaveAttribute('data-capability-class', 'ordinary');
    expect(line).toHaveTextContent(ORDINARY_CLASS_TAG);
    expect(line).toHaveTextContent(CAPABILITY_DECLARED_COPY['data.tables'].consequence);
    // Not presented as a grant: no chip, no control.
    expect(within(row).queryByText(CONSENT_STATE_ALLOWED)).toBeNull();
    expect(within(row).queryByText(CONSENT_STATE_NOT_ALLOWED)).toBeNull();
    expect(row.querySelectorAll('button')).toHaveLength(0);
  });

  it('a zero-capability row reads none, has no high-risk line, and renders grants-empty INSIDE it', () => {
    storeMock.status = {
      entries: [lifecycleEntry({ id: 'qa3146-no-capabilities', displayName: 'No Caps' })],
      loading: false,
      settled: true,
      error: null,
    };
    renderWithChakra(<InstalledAppsSettings />);

    const row = consentRow('qa3146-no-capabilities');
    expect(row).toHaveAttribute('data-consent-state', 'none');
    expect(row.querySelector('[data-capability-class="high-risk"]')).toBeNull();
    expect(within(row).getByTestId('installed-apps-grants-empty')).toHaveTextContent(
      GRANTS_EMPTY_LINE,
    );
  });

  it('reports allowed / not-allowed / none per the adjudicated rule (10.2)', () => {
    const allConsented = lifecycleEntry({
      id: 'all',
      displayName: 'All',
      capabilities: {
        appId: 'all',
        declared: ['high-risk.database-query'],
        highRisk: ['high-risk.database-query'],
        consented: ['high-risk.database-query'],
      },
    });
    const someUnconsented = lifecycleEntry({
      id: 'some',
      displayName: 'Some',
      capabilities: {
        appId: 'some',
        declared: ['high-risk.database-query', 'high-risk.database-reset'],
        highRisk: ['high-risk.database-query', 'high-risk.database-reset'],
        consented: ['high-risk.database-query'],
      },
    });
    const noneHighRisk = lifecycleEntry({
      id: 'none',
      displayName: 'None',
      capabilities: { appId: 'none', declared: ['data.tables'], highRisk: [], consented: [] },
    });
    storeMock.status = {
      entries: [allConsented, someUnconsented, noneHighRisk],
      loading: false,
      settled: true,
      error: null,
    };
    renderWithChakra(<InstalledAppsSettings />);

    expect(consentRow('all')).toHaveAttribute('data-consent-state', 'allowed');
    expect(consentRow('some')).toHaveAttribute('data-consent-state', 'not-allowed');
    expect(consentRow('none')).toHaveAttribute('data-consent-state', 'none');
  });

  it('is present even when no application declares a high-risk capability (Adjudication 10.1)', () => {
    storeMock.status = { entries: [ordinaryEntry()], loading: false, settled: true, error: null };
    renderWithChakra(<InstalledAppsSettings />);
    expect(screen.getByTestId('installed-apps-consent-section')).toBeInTheDocument();
    expect(screen.getAllByTestId('installed-apps-consent-row')).toHaveLength(1);
  });

  it('is absent when the list is empty (never an empty heading)', () => {
    storeMock.status = { entries: [], loading: false, settled: true, error: null };
    renderWithChakra(<InstalledAppsSettings />);
    expect(screen.queryByTestId('installed-apps-consent-section')).toBeNull();
    expect(screen.getByTestId('installed-apps-empty')).toBeInTheDocument();
  });
});

// ── Spec #3241 — S3, the mode badge on the settings row (R-3.3) ────────────

describe('#3241 — S3 the settings row carries the mode', () => {
  it('a development row carries data-app-mode, the badge, and the token as text', () => {
    storeMock.status = {
      entries: [lifecycleEntry({ mode: 'development' })],
      loading: false,
      settled: true,
      error: null,
    };
    renderWithChakra(<InstalledAppsSettings />);

    const row = screen.getByTestId('installed-apps-entry');
    expect(row).toHaveAttribute('data-app-mode', 'development');

    // The shared badge — the ONE renderer, so this word cannot drift from S4's.
    const badge = screen.getByTestId('installed-apps-entry-mode');
    expect(badge.textContent).toBe('Development');

    // INV-4: the lifecycle vocabulary is untouched and SEPARATE.
    expect(row).toHaveAttribute('data-app-state', 'working');
    // Exactly one state chip per row — the badge is an ADJACENT SIBLING, so the
    // shipped cardinality assertion still holds.
    expect(screen.getAllByTestId('installed-apps-entry-state')).toHaveLength(1);
  });

  it('a released row carries data-app-mode="released", NO badge node and no token in its text', () => {
    storeMock.status = {
      entries: [lifecycleEntry({ mode: 'released' })],
      loading: false,
      settled: true,
      error: null,
    };
    renderWithChakra(<InstalledAppsSettings />);

    // The surface exists and shows the released entry — absence against an empty
    // list would be vacuous (G-469 / UI/UX D-9a).
    const row = screen.getByTestId('installed-apps-entry');
    expect(row).toHaveTextContent('QA3147 Valid');

    // The attribute is ALWAYS present, so a missing one can never read as released.
    expect(row).toHaveAttribute('data-app-mode', 'released');
    expect(screen.queryByTestId('installed-apps-entry-mode')).toBeNull();
    expect(row.textContent).not.toContain('Development');
  });

  it('keeps the mode beside a TURNED-OFF state (two independent facts, not a contradiction)', () => {
    storeMock.status = {
      entries: [lifecycleEntry({ mode: 'development', state: 'disabled' })],
      loading: false,
      settled: true,
      error: null,
    };
    renderWithChakra(<InstalledAppsSettings />);

    const row = screen.getByTestId('installed-apps-entry');
    expect(row).toHaveAttribute('data-app-state', 'disabled');
    expect(row).toHaveAttribute('data-app-mode', 'development');
    expect(screen.getByTestId('installed-apps-entry-mode')).toHaveTextContent('Development');
    expect(within(row).getByText(STATE_WORDS.disabled)).toBeTruthy();
  });

  it('keeps the mode beside a FAILING state (broken and development are different facts)', () => {
    storeMock.status = {
      entries: [lifecycleEntry({ mode: 'development', state: 'failing', failureCode: 'integrity_mismatch' })],
      loading: false,
      settled: true,
      error: null,
    };
    renderWithChakra(<InstalledAppsSettings />);

    const row = screen.getByTestId('installed-apps-entry');
    expect(row).toHaveAttribute('data-app-state', 'failing');
    expect(row).toHaveAttribute('data-app-mode', 'development');
    expect(screen.getByTestId('installed-apps-entry-mode')).toHaveTextContent('Development');
  });

  it('leaves the shipped no-description slot byte-identical (Spec #3244 must survive)', () => {
    // The #3244 contract: an absent description renders the typed muted marker at
    // its own hook. The badge is added BESIDE the state chip, so it can never
    // displace this slot.
    storeMock.status = {
      entries: [lifecycleEntry({ mode: 'development', description: undefined })],
      loading: false,
      settled: true,
      error: null,
    };
    renderWithChakra(<InstalledAppsSettings />);

    const noDescription = screen.getByTestId('installed-apps-entry-no-description');
    expect(noDescription.textContent).toBe(NO_DESCRIPTION_MARKER);
    // Both the marker and the mode badge are present — the badge did not replace it.
    expect(screen.getByTestId('installed-apps-entry-mode')).toBeTruthy();
  });
});

// ── Spec #3241 — the shipped way to load a development build (R-3.1 / R-3.7) ──

describe('#3241 — the development load control', () => {
  it('is a TEXT button whose visible label IS its accessible name', () => {
    renderWithChakra(<InstalledAppsSettings />);

    const button = screen.getByTestId('installed-apps-install-development-button');
    // Text button, never icon-only: its text content is the full label.
    expect(button.textContent).toBe(INSTALL_DEVELOPMENT_BUTTON_LABEL);
    expect(INSTALL_DEVELOPMENT_BUTTON_LABEL).toBe('Load development build...');
    // No `aria-label` override — the visible label is the name, so they cannot diverge.
    expect(button.getAttribute('aria-label')).toBeNull();
    expect(screen.getByRole('button', { name: 'Load development build...' })).toBe(button);
  });

  it('calls installDevelopmentPackage and records the returned entry', async () => {
    const developmentEntry: InstalledAppEntry = {
      ...ENTRY,
      id: 'dev.example.wip',
      displayName: 'Example WIP',
      mode: 'development',
    };
    clientMock.installDevelopment = vi.fn(async () => developmentEntry);
    renderWithChakra(<InstalledAppsSettings />);

    fireEvent.click(screen.getByTestId('installed-apps-install-development-button'));

    await waitFor(() => expect(clientMock.installDevelopment).toHaveBeenCalledTimes(1));
    // The ordinary install is NOT the one that ran.
    expect(clientMock.install).not.toHaveBeenCalled();
    expect(storeMock.record).toHaveBeenCalledWith(developmentEntry);

    // The development sentence — NOT the shipped install sentence, which omits the
    // one fact the user just chose.
    const success = await screen.findByTestId('installed-apps-install-success');
    expect(success).toHaveTextContent(
      'Example WIP was loaded as a development build. Open it from the launcher, under Installed apps.',
    );
    expect(success).not.toHaveTextContent('is installed.');
  });

  it('controls stay live after a refusal (R-3.5 applied to the new control)', async () => {
    clientMock.installDevelopment = vi.fn(async () => {
      throw { code: 'io_error', detail: 'the picker was dismissed' };
    });
    renderWithChakra(<InstalledAppsSettings />);

    const button = screen.getByTestId('installed-apps-install-development-button');
    fireEvent.click(button);

    const refusal = await screen.findByTestId('installed-apps-refusal');
    expect(refusal).toHaveAttribute('data-refusal-code', 'io_error');

    // The refusal is DATA on screen, never a wedged surface: BOTH install controls
    // are live again, and the label survived (no spinner replaced it).
    await waitFor(() => {
      expect(screen.getByTestId('installed-apps-install-development-button')).not.toBeDisabled();
      expect(screen.getByTestId('installed-apps-install-button')).not.toBeDisabled();
    });
    expect(screen.getByTestId('installed-apps-install-development-button').textContent).toBe(
      INSTALL_DEVELOPMENT_BUTTON_LABEL,
    );
  });

  it('disables BOTH install controls while either load is in flight (one verdict slot)', async () => {
    let release: (() => void) | undefined;
    clientMock.installDevelopment = vi.fn(
      () =>
        new Promise<InstalledAppEntry>((resolve) => {
          release = () => resolve({ ...ENTRY, mode: 'development' });
        }),
    );
    renderWithChakra(<InstalledAppsSettings />);

    fireEvent.click(screen.getByTestId('installed-apps-install-development-button'));

    await waitFor(() => {
      expect(screen.getByTestId('installed-apps-install-development-button')).toBeDisabled();
      expect(screen.getByTestId('installed-apps-install-button')).toBeDisabled();
    });

    release?.();
    await waitFor(() => {
      expect(screen.getByTestId('installed-apps-install-development-button')).not.toBeDisabled();
    });
  });
});

