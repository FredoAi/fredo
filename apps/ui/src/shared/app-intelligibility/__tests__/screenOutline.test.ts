/**
 * Spec #3244 ST-4 — the screen-outline projector pins.
 *
 * The plan's committed pin for the projector is: "bounded node count; names +
 * bbox present", and the cap is enforced with `truncated` set. This suite drives
 * the REAL `simplifyDom` over a jsdom document:
 *   1. every emitted node carries a NON-EMPTY `name` and a 4-tuple `bbox`;
 *   2. `SCREEN_OUTLINE_MAX_NODES` is enforced and `truncated` is set when it bites;
 *   3. hidden subtrees contribute nothing, roles are derived, `testid` is an
 *      absent key when absent (G-413);
 *   4. the byte cap TRIMS (never silently over-sends) and re-declares `truncated`;
 *   5. the injection facts are derived from the turn's own inputs (R-4b), and the
 *      AC-5 witness is `taught:false` / `perAppEntries:0`.
 */

import { describe, expect, it } from 'vitest';

import {
  SCREEN_OUTLINE_MAX_BYTES,
  SCREEN_OUTLINE_MAX_NODES,
  contentDigest,
  fitOutlineToBytes,
  outlineBytes,
  serializeOutline,
  simplifyDom,
  utf8ByteLength,
  type ScreenOutline,
} from '@/shared/app-intelligibility/screenOutline';
import { buildCompanionInjectionFacts, pairPathTaught } from '@/shared/app-intelligibility/injection';

function render(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe('the declared caps', () => {
  it('are the plan values (120 nodes, 8192 UTF-8 bytes)', () => {
    expect(SCREEN_OUTLINE_MAX_NODES).toBe(120);
    expect(SCREEN_OUTLINE_MAX_BYTES).toBe(8192);
  });
});

describe('simplifyDom — a bounded, named projection', () => {
  it('emits a named node with a role and a 4-tuple bbox for every element', () => {
    const root = render(`
      <div data-fredo-app-id="wireframe">
        <button data-testid="wf-add">Add rectangle</button>
        <a href="#">Open the manual</a>
        <input type="checkbox" aria-label="Snap to grid" />
        <p>Just some prose</p>
      </div>
    `);

    const outline = simplifyDom(root, SCREEN_OUTLINE_MAX_NODES);
    expect(outline.truncated).toBe(false);
    expect(outline.nodes.length).toBeGreaterThan(0);

    for (const node of outline.nodes) {
      expect(typeof node.name).toBe('string');
      expect(node.name.length).toBeGreaterThan(0);
      expect(node.bbox).toHaveLength(4);
      for (const component of node.bbox) expect(Number.isInteger(component)).toBe(true);
    }

    const byName = new Map(outline.nodes.map((node) => [node.name, node]));
    expect(byName.get('Add rectangle')?.role).toBe('button');
    expect(byName.get('Add rectangle')?.testid).toBe('wf-add');
    expect(byName.get('Open the manual')?.role).toBe('link');
    expect(byName.get('Snap to grid')?.role).toBe('checkbox');
    // An element with no explicit role gets a tag-derived one, never a missing key.
    expect(byName.get('Just some prose')?.role).toBe('paragraph');
  });

  it('omits the `testid` key entirely when the element has none (G-413)', () => {
    const root = render('<button>No testid here</button>');
    const outline = simplifyDom(root, SCREEN_OUTLINE_MAX_NODES);
    const node = outline.nodes.find((candidate) => candidate.name === 'No testid here');
    expect(node).toBeDefined();
    expect('testid' in (node as object)).toBe(false);
  });

  it('skips an element with no accessible name and a hidden subtree', () => {
    const root = render(`
      <div>
        <button aria-hidden="true">Secret control</button>
        <span hidden>Hidden text</span>
        <button>Visible control</button>
      </div>
    `);
    const names = simplifyDom(root, SCREEN_OUTLINE_MAX_NODES).nodes.map((node) => node.name);
    expect(names).toContain('Visible control');
    expect(names).not.toContain('Secret control');
    expect(names).not.toContain('Hidden text');
  });

  it('enforces SCREEN_OUTLINE_MAX_NODES and sets `truncated`', () => {
    const buttons = Array.from(
      { length: SCREEN_OUTLINE_MAX_NODES + 25 },
      (_unused, index) => `<button>Control ${index}</button>`,
    ).join('');
    const root = render(`<div>${buttons}</div>`);

    const outline = simplifyDom(root, SCREEN_OUTLINE_MAX_NODES);
    expect(outline.nodes).toHaveLength(SCREEN_OUTLINE_MAX_NODES);
    expect(outline.truncated).toBe(true);
    // Exactly the first N in document order — the cap drops the TAIL.
    expect(outline.nodes[0]?.name).toBe('Control 0');
    expect(outline.nodes[SCREEN_OUTLINE_MAX_NODES - 1]?.name).toBe(
      `Control ${SCREEN_OUTLINE_MAX_NODES - 1}`,
    );
  });

  it('a zero cap yields no nodes and declares the truncation', () => {
    const root = render('<button>Only control</button>');
    const outline = simplifyDom(root, 0);
    expect(outline.nodes).toHaveLength(0);
    expect(outline.truncated).toBe(true);
  });
});

describe('serialization and the byte cap', () => {
  function wideOutline(count: number): ScreenOutline {
    return {
      nodes: Array.from({ length: count }, (_unused, index) => ({
        role: 'button',
        name: `A reasonably long control name number ${index} for the byte test`,
        tag: 'button',
        bbox: [10, 20, 120, 32] as const,
      })),
      truncated: false,
    };
  }

  it('serializes exactly {nodes, truncated} and reports its UTF-8 size', () => {
    const outline = wideOutline(3);
    const json = serializeOutline(outline);
    const parsed = JSON.parse(json) as { nodes: unknown[]; truncated: boolean };
    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.truncated).toBe(false);
    expect(outlineBytes(outline)).toBe(utf8ByteLength(json));
  });

  it('fitOutlineToBytes trims to the budget and re-declares `truncated`', () => {
    const outline = wideOutline(80);
    const budget = 600;
    expect(outlineBytes(outline)).toBeGreaterThan(budget);

    const fitted = fitOutlineToBytes(outline, budget);
    expect(fitted.truncated).toBe(true);
    expect(fitted.nodes.length).toBeLessThan(outline.nodes.length);
    expect(outlineBytes(fitted)).toBeLessThanOrEqual(budget);
  });

  it('fitOutlineToBytes is a no-op on an outline that already fits', () => {
    const outline = wideOutline(2);
    const fitted = fitOutlineToBytes(outline, SCREEN_OUTLINE_MAX_BYTES);
    expect(fitted).toEqual(outline);
  });

  it('contentDigest is deterministic and change-sensitive', () => {
    expect(contentDigest('aaa')).toBe(contentDigest('aaa'));
    expect(contentDigest('aaa')).not.toBe(contentDigest('aab'));
    expect(contentDigest('aaa')).toMatch(/^[0-9a-f]+$/);
  });
});

describe('the injection facts (the live receipt)', () => {
  const outline: ScreenOutline = {
    nodes: [
      { role: 'button', name: 'Save', tag: 'button', bbox: [1, 2, 3, 4] },
    ],
    truncated: false,
  };

  it('derives its numbers from the turn inputs, never a constant (R-4b)', () => {
    const facts = buildCompanionInjectionFacts({
      appId: 'qa3244-untaught',
      description: 'A sample reader app.',
      outline,
      screenshotPngBase64: 'iVBORw0KGgo=',
    });
    expect(facts.appId).toBe('qa3244-untaught');
    expect(facts.descriptionBytes).toBe(utf8ByteLength('A sample reader app.'));
    expect(facts.screenshotBytes).toBe(utf8ByteLength('iVBORw0KGgo='));
    expect(facts.simplifiedHtmlBytes).toBe(outlineBytes(outline));
    expect(facts.screenshotDigest).toBe(contentDigest('iVBORw0KGgo='));
    expect(facts.simplifiedHtmlDigest).toBe(contentDigest(serializeOutline(outline)));
  });

  it('carries the AC-5 negative witness (taught:false / perAppEntries:0)', () => {
    expect(pairPathTaught()).toBe(false);
    const facts = buildCompanionInjectionFacts({
      appId: 'mission-monitor',
      outline,
      screenshotPngBase64: 'AAAA',
    });
    expect(facts.taught).toBe(false);
    expect(facts.perAppEntries).toBe(0);
  });

  it('changes a digest when the screen changes (freshness is observable)', () => {
    const before = buildCompanionInjectionFacts({
      appId: 'a',
      outline,
      screenshotPngBase64: 'screen-one',
    });
    const after = buildCompanionInjectionFacts({
      appId: 'a',
      outline: {
        nodes: [...outline.nodes, { role: 'textbox', name: 'Table name', tag: 'input', bbox: [5, 6, 7, 8] }],
        truncated: false,
      },
      screenshotPngBase64: 'screen-two',
    });
    expect(after.screenshotDigest).not.toBe(before.screenshotDigest);
    expect(after.simplifiedHtmlDigest).not.toBe(before.simplifiedHtmlDigest);
  });
});
