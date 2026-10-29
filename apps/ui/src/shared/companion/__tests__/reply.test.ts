/**
 * Companion application-skill reply copy (Spec #3099, ST-6).
 *
 * Pins the four bound strings verbatim (UI/UX §4 / QA Q-6/Q-10/Q-14/Q-15):
 *   - the list uses `; ` + U+2014, lists every published id in declaration
 *     order with its description, never `listActions`, and has NO trailing
 *     period;
 *   - the performed sentence names DESCRIPTIONS (never ids) in `performed`
 *     order with a BINDING terminal period;
 *   - the unknown reply echoes the action with plain ASCII quotes;
 *   - the nothing-changed sentence names the application and claims nothing.
 * Plus the `listLabel` default / override / blank-is-absent rule.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import type { CompanionManifest, CompanionSurfaceManifest } from '../manifest';
import {
  appCommandListLabel,
  appCommandListReply,
  appCommandNothingChangedReply,
  appCommandPerformedReply,
  appCommandUnknownActionReply,
} from '../reply';

const SURFACE: CompanionSurfaceManifest = {
  appId: 'demo',
  appName: 'Demo',
  skillName: 'demo',
  description: 'Do demo things.',
  commands: [
    {
      id: 'demo.add.text',
      label: 'Text',
      description: 'Add a text element (body or heading style)',
      args: [],
    },
    {
      id: 'demo.add.card',
      label: 'Card',
      description: 'Add a card/container element',
      args: [],
    },
  ],
};

describe('appCommandListReply (R-4a/R-4b)', () => {
  it('is `<appName> actions: <id> — <description>; …` with no trailing period', () => {
    const reply = appCommandListReply(SURFACE);
    expect(reply).toBe(
      'Demo actions: demo.add.text — Add a text element (body or heading style); demo.add.card — Add a card/container element',
    );
    expect(reply.endsWith('.')).toBe(false);
    // U+2014 EM DASH, never a hyphen or an en dash.
    expect(reply).toContain('\u2014');
    expect(reply).not.toContain(' - ');
  });

  it('uses the declared listLabel override verbatim', () => {
    const reply = appCommandListReply({ ...SURFACE, listLabel: 'Demo capabilities' });
    expect(reply.startsWith('Demo capabilities: demo.add.text — ')).toBe(true);
  });

  it('falls back to `<appName> actions` for a blank listLabel', () => {
    expect(appCommandListLabel({ ...SURFACE, listLabel: '   ' })).toBe('Demo actions');
    expect(appCommandListReply({ ...SURFACE, listLabel: '' }).startsWith('Demo actions: ')).toBe(
      true,
    );
  });

  it('never lists the reserved listActions id', () => {
    const withReserved: CompanionSurfaceManifest = {
      ...SURFACE,
      commands: [
        ...SURFACE.commands,
        { id: 'listActions', label: 'List', description: 'Should be skipped', args: [] },
      ],
    };
    const reply = appCommandListReply(withReserved);
    expect(reply).not.toContain('listActions');
    expect(reply.split('; ')).toHaveLength(SURFACE.commands.length);
  });

  it('lists EVERY published command of the shipped Wireframe surface in order', () => {
    const raw = readFileSync(
      resolve(process.cwd(), 'src/shared/companion/fixtures/wireframe.companion.golden.json'),
      'utf8',
    );
    const fixture = JSON.parse(raw) as { manifest: CompanionManifest };
    const surface = fixture.manifest.surfaces[0];

    const reply = appCommandListReply(surface);
    expect(reply.startsWith('Wireframe actions: wireframe.add.text — Add a text element (body or heading style); ')).toBe(true);
    expect(reply).not.toContain('listActions');
    expect(reply.split('; ')).toHaveLength(surface.commands.length);
    for (const command of surface.commands) {
      expect(reply).toContain(`${command.id} — ${command.description}`);
    }
  });
});

describe('appCommandPerformedReply (R-2, UI/UX binding)', () => {
  it('joins the DESCRIPTION of each performed id in order with a terminal period', () => {
    const reply = appCommandPerformedReply(SURFACE, ['demo.add.card', 'demo.add.text']);
    expect(reply).toBe(
      'Performed in Demo: Add a card/container element, Add a text element (body or heading style).',
    );
    // Terminal period is BINDING.
    expect(reply.endsWith('.')).toBe(true);
  });

  it('never renders an id in the performed list', () => {
    const reply = appCommandPerformedReply(SURFACE, ['demo.add.text']);
    expect(reply).toBe('Performed in Demo: Add a text element (body or heading style).');
    expect(reply).not.toContain('demo.add.text');
  });
});

describe('appCommandUnknownActionReply (R-3a)', () => {
  it('echoes the action with plain ASCII quotes', () => {
    expect(appCommandUnknownActionReply(SURFACE, 'demo.teleport')).toBe(
      'I don\'t know the Demo action "demo.teleport". Nothing changed.',
    );
    expect(appCommandUnknownActionReply(SURFACE, 'demo.teleport')).not.toContain('\u201c');
  });
});

describe('appCommandNothingChangedReply (R-3)', () => {
  it('names the application and claims nothing changed', () => {
    expect(appCommandNothingChangedReply(SURFACE)).toBe(
      "I couldn't do that in Demo. Nothing changed.",
    );
  });
});
