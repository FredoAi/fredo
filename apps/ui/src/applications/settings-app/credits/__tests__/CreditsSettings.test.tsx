/**
 * Spec #3206 ST-3 — the Credits pane (UI/UX §1–§6; QA rows F-1a, F-2b, F-3, F-4,
 * F-5, F-6, F-11b, F-14, F-17a).
 *
 * The pane is a rendered VIEW of the generated artifact
 * (`credits.generated.ts`), so this suite does two things a screenshot cannot:
 * it asserts the DOM against the artifact FIELD BY FIELD (no text scraping), and
 * it proves the absence-shaped claims with instruments that are first shown to
 * SEE the thing they assert absent.
 *
 * Two shapes are load-bearing here:
 *
 * 1. **The link is a BUTTON, never an `<a href>`.** A same-tab anchor would
 *    replace the Settings document (the CSP's `default-src 'self'` does not
 *    restrict top-level navigation) and `target="_blank"` is cancelled by wry.
 *    The zero-`[href]` assertion is paired with a self-test that injects an
 *    anchor and finds it, so the selector cannot pass vacuously.
 * 2. **The licence trigger reads `<identifier> licence text`, never "Full
 *    text"** — two of the nine panels are the doc's own prose, not a licence
 *    body, so "full text" would be a false claim on exactly those.
 *
 * Layout/token properties are pinned as a SOURCE assertion (the last block):
 * Chakra props become emotion classes, not inline styles, so reading
 * `element.style` would be a reading from an instrument that cannot see them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

vi.mock('@/shared/utils/adapterBridge', () => ({
  adapterBridge: {
    invoke: vi.fn(),
    listen: vi.fn().mockResolvedValue(() => {}),
  },
}));

import { adapterBridge } from '@/shared/utils/adapterBridge';
import { CREDIT_ENTRIES, CREDITS_SOURCE, DOOM_TRADEMARK, FREDO_LICENCE } from '../credits.generated';
import {
  CREDITS_SUBTITLE,
  CREDITS_TITLE,
  CreditsSettings,
  GROUP_DESIGN_REFERENCES,
  GROUP_FREDO_LICENCE,
  GROUP_THIRD_PARTY,
  GROUP_TRADEMARKS,
  LICENCE_TRIGGER_SUFFIX,
  canonicalSourceLine,
  linkAccessibleName,
  linkRefusalSentence,
  linkVisibleLabel,
  refusalCodeFrom,
} from '../CreditsSettings';

const invokeMock = vi.mocked(adapterBridge.invoke);

afterEach(cleanup);
beforeEach(() => {
  invokeMock.mockReset();
});

/**
 * The frozen testid shape is `credits-field-<id>-<slug of the doc field label>`
 * (Architect's names block). Re-derived HERE, independently of the component's
 * own helper, so the assertion proves the DOM matches the convention rather than
 * that the component agrees with itself.
 */
function frozenFieldSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function creditsRoot(): HTMLElement {
  return screen.getByTestId('credits-settings');
}

/** The panel element that follows a trigger inside its accordion item. */
function panelOf(trigger: HTMLElement): HTMLElement {
  const panel = trigger.nextElementSibling;
  expect(panel?.getAttribute('data-part'), 'the trigger must be followed by its panel').toBe(
    'item-content',
  );
  return panel as HTMLElement;
}

describe('#3206 ST-3 — the Credits pane renders from the artifact, synchronously', () => {
  it('renders its final content on the first paint (no loading state exists)', () => {
    renderWithChakra(<CreditsSettings />);
    // Not `findBy*`: the data is a static ES import, so a skeleton would fail here.
    expect(creditsRoot()).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: CREDITS_TITLE })).toBeInTheDocument();
    expect(screen.getByText(CREDITS_SUBTITLE)).toBeInTheDocument();
  });

  it('carries the heading tree h2 → h3 → h4 with no level skipped and the doc order preserved', () => {
    renderWithChakra(<CreditsSettings />);
    const root = creditsRoot();

    expect([...root.querySelectorAll('h2')].map((node) => node.textContent)).toEqual([CREDITS_TITLE]);
    expect([...root.querySelectorAll('h3')].map((node) => node.textContent)).toEqual([
      GROUP_THIRD_PARTY,
      GROUP_FREDO_LICENCE,
      GROUP_DESIGN_REFERENCES,
      GROUP_TRADEMARKS,
    ]);
    // Each entry name is an h4 (jump straight to "Vulkan" out of six cards); the
    // Fredo block deliberately has none — its group h3 is its heading.
    expect([...root.querySelectorAll('h4')].map((node) => node.textContent)).toEqual([
      'llama.cpp',
      'Vulkan',
      'ggml',
      'neurodoom',
      'DOOM1.WAD',
      'Posable Doomguy',
    ]);
    expect(root.querySelector('h1')).toBeNull();
  });

  it('orders the groups entries → Fredo licence → design reference → trademark, per the doc', () => {
    renderWithChakra(<CreditsSettings />);

    const sectionEntries = CREDIT_ENTRIES.filter((entry) => entry.section <= 4);
    const designEntries = CREDIT_ENTRIES.filter((entry) => entry.section === 7);
    expect(sectionEntries).toHaveLength(5); // §2 contributes two (Vulkan + ggml)
    expect(designEntries).toHaveLength(1);

    const ordered = [
      ...sectionEntries.map((entry) => screen.getByTestId(`credits-entry-${entry.id}`)),
      screen.getByTestId('credits-fredo-licence'),
      ...designEntries.map((entry) => screen.getByTestId(`credits-entry-${entry.id}`)),
      screen.getByTestId('credits-doom-trademark'),
    ];

    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      expect(
        previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${current.getAttribute('data-testid')} must follow ${previous.getAttribute('data-testid')}`,
      ).toBeTruthy();
    }
  });

  it('renders every artifact field as a dl pair, with the frozen testid on the dt and the value in its dd', () => {
    renderWithChakra(<CreditsSettings />);

    for (const entry of CREDIT_ENTRIES) {
      expect(screen.getByTestId(`credits-entry-name-${entry.id}`)).toHaveTextContent(entry.name);

      for (const field of entry.fields) {
        const term = screen.getByTestId(`credits-field-${entry.id}-${frozenFieldSlug(field.label)}`);
        expect(term.tagName).toBe('DT');
        expect(term.textContent).toBe(field.label);
        const value = term.nextElementSibling;
        expect(value?.tagName).toBe('DD');
        expect(value?.textContent).toBe(field.value);
      }
    }
  });

  it('gives every entry exactly one upstream link button', () => {
    renderWithChakra(<CreditsSettings />);
    for (const entry of CREDIT_ENTRIES) {
      expect(screen.getAllByTestId(`credits-link-${entry.id}`)).toHaveLength(1);
    }
  });
});

describe('#3206 ST-3 — Fredo’s own licence (AC-2 / R-2.1, R-2.2)', () => {
  it('states the dual licence from the doc preamble, as data', () => {
    renderWithChakra(<CreditsSettings />);
    const block = screen.getByTestId('credits-fredo-licence');
    expect(block).toHaveTextContent(FREDO_LICENCE.statement);
    expect(block).toHaveTextContent('MIT');
    expect(block).toHaveTextContent('Apache-2.0');
  });

  it('expands both bodies to the COMPLETE file text — asserted by top and tail anchors, not "non-empty"', async () => {
    const user = userEvent.setup();
    renderWithChakra(<CreditsSettings />);

    for (const body of FREDO_LICENCE.licenceBodies) {
      const trigger = screen.getByTestId(`credits-body-fredo-${body.id}`);
      const panel = panelOf(trigger);
      expect(panel.hasAttribute('hidden')).toBe(true);

      await user.click(trigger);

      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(panel.hasAttribute('hidden')).toBe(false);

      const text = screen.getByTestId(`credits-text-fredo-${body.id}`);
      // Equality with the artifact's own text is the R-2.2 criterion; the
      // top/tail anchors are the second, human-readable half (a first-N-lines
      // stub or a `…` elision fails on both).
      expect(text.textContent).toBe(body.text);
      expect(text.textContent!.length).toBe(body.text.length);
    }

    const mit = screen.getByTestId('credits-text-fredo-mit').textContent!;
    expect(mit.startsWith('MIT License')).toBe(true);
    expect(mit.trimEnd().endsWith('SOFTWARE.')).toBe(true);

    const apacheNode = screen.getByTestId('credits-text-fredo-apache-2-0');
    const apache = apacheNode.textContent!;
    expect(apache).toContain('Apache License');
    expect(apache).toContain('END OF TERMS AND CONDITIONS');
    expect(apache).toContain('APPENDIX: How to apply the Apache License to your work.');
    // The Apache body carries an `http://` address — it must stay TEXT, never a
    // linkified anchor (a linkified one would violate https-only AND navigate).
    expect(apacheNode.querySelectorAll('a')).toHaveLength(0);
    expect(apache).toContain('http://www.apache.org/licenses/');
  });

  it('keeps both Fredo bodies open at once (multiple, independent expansion)', async () => {
    const user = userEvent.setup();
    renderWithChakra(<CreditsSettings />);

    await user.click(screen.getByTestId('credits-body-fredo-mit'));
    await user.click(screen.getByTestId('credits-body-fredo-apache-2-0'));

    for (const body of FREDO_LICENCE.licenceBodies) {
      expect(
        screen.getByTestId(`credits-body-fredo-${body.id}`).getAttribute('aria-expanded'),
      ).toBe('true');
    }
  });
});

describe('#3206 ST-3 — the licence affordance and its panels (§1.2, §5.2)', () => {
  it('labels every trigger `<doc identifier> licence text` — never "Full text"', () => {
    renderWithChakra(<CreditsSettings />);

    const allBodies = [
      ...CREDIT_ENTRIES.flatMap((entry) =>
        entry.licenceBodies.map((body) => ({ prefix: entry.id, label: body.label, body })),
      ),
      ...FREDO_LICENCE.licenceBodies.map((body) => ({ prefix: 'fredo', label: body.label, body })),
    ];
    expect(allBodies).toHaveLength(9); // 7 entry bodies + the 2 Fredo bodies

    for (const { prefix, label, body } of allBodies) {
      const trigger = screen.getByTestId(`credits-body-${prefix}-${body.id}`);
      expect(trigger.tagName).toBe('BUTTON');
      expect(trigger).toHaveTextContent(`${label} ${LICENCE_TRIGGER_SUFFIX}`);
      // The visible text IS the accessible name — no aria-label masking
      // `aria-expanded`'s subject.
      expect(trigger.getAttribute('aria-label')).toBeNull();
      expect(trigger.hasAttribute('tabindex')).toBe(false);
    }

    expect(LICENCE_TRIGGER_SUFFIX).toBe('licence text');
    expect(creditsRoot().textContent).not.toContain('Full text');
  });

  it('reports aria-expanded and keeps the panel hidden while collapsed', () => {
    renderWithChakra(<CreditsSettings />);

    for (const entry of CREDIT_ENTRIES) {
      for (const body of entry.licenceBodies) {
        const trigger = screen.getByTestId(`credits-body-${entry.id}-${body.id}`);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(panelOf(trigger).hasAttribute('hidden')).toBe(true);
      }
    }
  });

  it('exposes an aria-controls pair that resolves to the panel it labels', async () => {
    const user = userEvent.setup();
    renderWithChakra(<CreditsSettings />);

    const trigger = screen.getByTestId('credits-body-llama-cpp-mit');
    const controls = trigger.getAttribute('aria-controls');
    expect(controls, 'the installed Zag/Chakra must emit aria-controls (U-6)').not.toBeNull();
    const panel = document.getElementById(controls!);
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute('data-part')).toBe('item-content');

    await user.click(trigger);
    expect(panel!.hasAttribute('hidden')).toBe(false);
  });
});

describe('#3206 ST-3 — the design reference and the trademark notice (AC-3)', () => {
  it('renders §7’s `Reference only — no geometry shipped` with the exact characters', () => {
    renderWithChakra(<CreditsSettings />);

    const term = screen.getByTestId('credits-field-posable-doomguy-distribution-form');
    const value = term.nextElementSibling!.textContent!;
    const artefact = CREDIT_ENTRIES.find((entry) => entry.id === 'posable-doomguy')!.fields.find(
      (field) => field.label === 'Distribution form',
    )!.value;

    expect(value).toBe(artefact);
    // Capital R, em dash U+2014, a space either side, NO period before the dash.
    expect(value).toContain('Reference only \u2014 no geometry shipped');
    expect(value.startsWith('Reference only \u2014 no geometry shipped')).toBe(true);
    expect(value).not.toContain('Reference only - no geometry shipped');
    expect(value).not.toContain('Reference only. ');
  });

  it('renders the DOOM trademark + non-affiliation notice verbatim, always visible', () => {
    renderWithChakra(<CreditsSettings />);

    const notice = screen.getByTestId('credits-doom-trademark');
    expect(notice.textContent).toBe(DOOM_TRADEMARK.text);
    expect(notice).toHaveTextContent(
      'DOOM and the DOOM logo are trademarks of id Software LLC / ZeniMax Media Inc.',
    );
    // The sentence that must never be lost, in its exact characters.
    expect(notice).toHaveTextContent(
      'Fredo is not affiliated with, endorsed by, or sponsored by id Software; the DOOM name is used only to identify the bundled shareware game data.',
    );
    // Not behind a disclosure: a legal disclaimer a user must expand is not one.
    expect(notice.closest('[data-part="item-content"]')).toBeNull();
    expect(notice.closest('[hidden]')).toBeNull();
  });

  it('names the canonical source and states that the list is generated from it', () => {
    renderWithChakra(<CreditsSettings />);
    expect(creditsRoot()).toHaveTextContent(canonicalSourceLine(CREDITS_SOURCE.docPath));
    expect(creditsRoot()).toHaveTextContent('this list is generated from that file');
  });
});

describe('#3206 ST-3 — the upstream affordance is a BUTTON, and the pane has zero [href] (F-11)', () => {
  it('renders every link button without href/target and with the frozen accessible name', () => {
    renderWithChakra(<CreditsSettings />);

    for (const entry of CREDIT_ENTRIES) {
      const button = screen.getByTestId(`credits-link-${entry.id}`);
      expect(button.tagName).toBe('BUTTON');
      expect(button.hasAttribute('href')).toBe(false);
      expect(button.hasAttribute('target')).toBe(false);
      expect(button.getAttribute('aria-label')).toBe(linkAccessibleName(entry.name));
      // WCAG 2.5.3 Label in Name: the visible text is CONTAINED in the name.
      expect(linkVisibleLabel(entry.name)).toBe(`${entry.name} upstream page`);
      expect(button.getAttribute('aria-label')).toContain(linkVisibleLabel(entry.name));
      expect(button.textContent).toContain(linkVisibleLabel(entry.name));
    }
  });

  it('contains ZERO [href] and ZERO [target] nodes — with a selector self-test that SEES an injected anchor', () => {
    renderWithChakra(<CreditsSettings />);
    const root = creditsRoot();

    expect(root.querySelectorAll('[href]')).toHaveLength(0);
    expect(root.querySelectorAll('[target]')).toHaveLength(0);

    // Non-vacuity: the same selector must find an anchor that IS there, or a zero
    // from it would be a reading from an unproven instrument (G-408).
    const probe = document.createElement('a');
    probe.setAttribute('href', '#injected-probe');
    probe.setAttribute('target', '_blank');
    root.appendChild(probe);
    expect(root.querySelectorAll('[href]')).toHaveLength(1);
    expect(root.querySelectorAll('[target]')).toHaveLength(1);
    probe.remove();
    expect(root.querySelectorAll('[href]')).toHaveLength(0);
    expect(root.querySelectorAll('[target]')).toHaveLength(0);
  });
});

describe('#3206 ST-3 — link activation and the inline refusal (R-5.1/R-5.2, client half)', () => {
  it('invokes open_external_link exactly once with that entry’s upstreamUrl', async () => {
    const user = userEvent.setup();
    invokeMock.mockResolvedValue(undefined);
    renderWithChakra(<CreditsSettings />);

    const llama = CREDIT_ENTRIES.find((entry) => entry.id === 'llama-cpp')!;
    await user.click(screen.getByTestId('credits-link-llama-cpp'));

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('open_external_link', { url: llama.upstreamUrl });
    expect(llama.upstreamUrl).toBe('https://github.com/ggml-org/llama.cpp');

    const vulkan = CREDIT_ENTRIES.find((entry) => entry.id === 'vulkan')!;
    await user.click(screen.getByTestId('credits-link-vulkan'));
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith('open_external_link', { url: vulkan.upstreamUrl });
    // §2's Upstream cell carries TWO URLs; the FIRST is the activatable one.
    expect(vulkan.upstreamUrl).toBe('https://www.vulkan.org/');
  });

  it('drops a second activation while the first invoke is pending (in-flight guard, never disabled)', async () => {
    const user = userEvent.setup();
    let settle: (() => void) | undefined;
    invokeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    renderWithChakra(<CreditsSettings />);

    const button = screen.getByTestId('credits-link-llama-cpp');
    await user.click(button);
    expect(button).not.toBeDisabled(); // the guard is logic, not a disabled state
    await user.click(button);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    settle!();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
  });

  it('renders ONE inline role="alert" under the clicked entry naming it and pointing at the address above', async () => {
    const user = userEvent.setup();
    invokeMock.mockRejectedValue('external link refused: loopback-host');
    renderWithChakra(<CreditsSettings />);

    const locationBefore = window.location.href;
    await user.click(screen.getByTestId('credits-link-llama-cpp'));

    await waitFor(() => expect(screen.getByTestId('credits-link-error')).toBeInTheDocument());
    expect(screen.getAllByTestId('credits-link-error')).toHaveLength(1);

    const alert = screen.getByTestId('credits-link-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveAttribute('data-refusal-code', 'loopback-host');
    expect(alert).toHaveTextContent(linkRefusalSentence('llama.cpp'));
    // The typed backend string is rendered unedited, never paraphrased.
    expect(alert).toHaveTextContent('external link refused: loopback-host');
    // The alert lives under the button that was clicked.
    expect(screen.getByTestId('credits-entry-llama-cpp')).toContainElement(alert);
    // The window was untouched: no navigation, no new document.
    expect(window.location.href).toBe(locationBefore);
  });

  it('moves the single alert to the entry just tried, and remounts it on a repeat failure', async () => {
    const user = userEvent.setup();
    invokeMock.mockRejectedValue('external link refused: not-https');
    renderWithChakra(<CreditsSettings />);

    await user.click(screen.getByTestId('credits-link-llama-cpp'));
    await waitFor(() => expect(screen.getByTestId('credits-link-error')).toBeInTheDocument());
    expect(screen.getByTestId('credits-entry-llama-cpp')).toContainElement(
      screen.getByTestId('credits-link-error'),
    );

    await user.click(screen.getByTestId('credits-link-vulkan'));
    await waitFor(() =>
      expect(screen.getByTestId('credits-entry-vulkan')).toContainElement(
        screen.getByTestId('credits-link-error'),
      ),
    );
    expect(screen.getAllByTestId('credits-link-error')).toHaveLength(1);
    expect(screen.getByTestId('credits-entry-llama-cpp')).not.toContainElement(
      screen.getByTestId('credits-link-error'),
    );

    // A repeat of the SAME failure on the SAME entry must be announced again:
    // `role="alert"` does not re-announce unchanged content, so the node is
    // key-remounted per attempt.
    const firstAttempt = screen.getByTestId('credits-link-error');
    await user.click(screen.getByTestId('credits-link-vulkan'));
    await waitFor(() => expect(screen.getByTestId('credits-link-error')).not.toBe(firstAttempt));
    expect(screen.getAllByTestId('credits-link-error')).toHaveLength(1);
  });

  it('parses the `failed:` family too, and reports a refused code from the wire string', () => {
    expect(refusalCodeFrom('external link refused: loopback-host')).toBe('loopback-host');
    expect(refusalCodeFrom('external link refused: not-https')).toBe('not-https');
    expect(refusalCodeFrom('external link refused: no-host')).toBe('no-host');
    expect(refusalCodeFrom('external link refused: userinfo')).toBe('userinfo');
    expect(refusalCodeFrom('external link refused: malformed')).toBe('malformed');
    expect(refusalCodeFrom('external link failed: the system cannot find the file')).toBe('failed');
  });

  it('shows NO in-app feedback on success — the browser window is the feedback channel', async () => {
    const user = userEvent.setup();
    invokeMock.mockResolvedValue(undefined);
    renderWithChakra(<CreditsSettings />);

    await user.click(screen.getByTestId('credits-link-llama-cpp'));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    expect(screen.queryByTestId('credits-link-error')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(creditsRoot().textContent).not.toMatch(/opened in your browser/i);
  });

  it('opens collapsed again on a fresh mount (re-entry has no memory)', () => {
    const first = renderWithChakra(<CreditsSettings />);
    expect(screen.getByTestId('credits-body-fredo-mit').getAttribute('aria-expanded')).toBe('false');
    first.unmount();

    renderWithChakra(<CreditsSettings />);
    expect(screen.getByTestId('credits-body-fredo-mit').getAttribute('aria-expanded')).toBe('false');
  });
});

/**
 * The properties Chakra turns into emotion classes are pinned at the SOURCE, the
 * only instrument that can read them (U-10's static half). `element.style` is
 * empty for a Chakra prop, so a DOM read here would be vacuously green.
 */
describe('#3206 ST-3 — the pane source keeps one scroller, no truncation and the `<pre>` contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/applications/settings-app/credits/CreditsSettings.tsx'),
    'utf8',
  );
  /** Scan CODE only: the header prose quotes the very shapes this block forbids. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('defines no second scroll container and truncates nothing', () => {
    expect(code).not.toMatch(/overflowY?\b/);
    expect(code).not.toMatch(/maxH\b/);
    expect(code).not.toMatch(/lineClamp/);
    expect(code).not.toMatch(/\btruncate\b/);
    expect(code).not.toMatch(/overflow="(auto|scroll|hidden)"/);
  });

  it('renders a licence body as a margin-reset, wrapping `<pre>` of plain text', () => {
    expect(code).toContain('as="pre"');
    expect(code).toContain('m={0}');
    expect(code).toContain('whiteSpace="pre-wrap"');
    expect(code).toContain('overflowWrap="anywhere"');
    expect(code).toContain('userSelect="text"');
    expect(code).toContain('fontFamily="mono"');
  });

  it('renders the link affordance as an underlined pointer Button', () => {
    expect(code).toContain('variant="plain"');
    expect(code).toContain('cursor="pointer"');
    expect(code).toContain('textDecoration="underline"');
    expect(code).not.toContain('<a ');
    expect(code).not.toContain('href=');
    expect(code).not.toContain('target=');
  });
});
