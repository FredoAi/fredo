/**
 * Spec #3243 ST-4 — the ONE copy source's pins (ADJ-3, ADJ-4, G-505).
 *
 * Two assertions here are the ones that fail on the WRONG product rather than
 * the broken one, and both are deliberate:
 *
 *  - `orderCancelledReply` must NOT contain the unknown-refusal wording, and
 *    `orderRefusedUnknownReply` must NOT contain the cancellation wording. A
 *    user who cancelled understood the order and changed their mind; a user
 *    whose order could not be resolved has a different next action (reword).
 *    Borrowing either sentence for the other condition is the G-505 defect.
 *  - every settle formatter must name BOTH the label and the app, because the
 *    ticker is read after the user left and returned to a different app.
 */
import { describe, expect, it } from 'vitest';

import {
  ORDER_IRREVERSIBLE_NOTICE,
  ORDER_UNDOABLE_NOTICE,
  orderCancelledReply,
  orderIrreversibleWarning,
  orderNeedsConfirmationReply,
  orderNothingToUndoReply,
  orderPerformedReply,
  orderRefusedUnknownReply,
  orderUndoReply,
} from '../orderReply';

const APP = 'Wireframe';
const LABEL = 'Fill element';

/** Every curly quote/apostrophe the copy rules forbid. */
const CURLY = ['\u2018', '\u2019', '\u201c', '\u201d', '\u2013', '\u2014'];

function expectPlainAscii(text: string): void {
  for (const forbidden of CURLY) {
    expect(text).not.toContain(forbidden);
  }
}

describe('orderReply — exact copy (the ticker is the durable record)', () => {
  it('performed names BOTH the label and the app', () => {
    const reply = orderPerformedReply(APP, LABEL);
    expect(reply).toBe('Done - Fill element in Wireframe');
    expect(reply).toContain(LABEL);
    expect(reply).toContain(APP);
    expectPlainAscii(reply);
  });

  it('needs-confirmation names BOTH the label and the app', () => {
    const reply = orderNeedsConfirmationReply(APP, LABEL);
    expect(reply).toBe('Needs your confirmation - Fill element in Wireframe');
    expect(reply).toContain(LABEL);
    expect(reply).toContain(APP);
    expectPlainAscii(reply);
  });

  it('undo names BOTH the label and the app', () => {
    const reply = orderUndoReply(APP, LABEL);
    expect(reply).toBe('Undone - Fill element in Wireframe');
    expect(reply).toContain(LABEL);
    expect(reply).toContain(APP);
    expectPlainAscii(reply);
  });

  it('a label-ONLY formatter would be unreadable — the app name is asserted, not optional', () => {
    // The G-520 mutation: `orderPerformedReply(label)` returns `Done - Fill`.
    // This asserts the app name is present so that mutation reddens here.
    expect(orderPerformedReply(APP, LABEL)).toContain(`${APP}`);
    expect(orderPerformedReply(APP, LABEL)).not.toBe(`Done - ${LABEL}`);
  });
});

describe('orderReply — G-505: the cancelled sentence is NOT the unknown-refusal sentence', () => {
  it('orderCancelledReply names the user decision and states nothing changed', () => {
    const reply = orderCancelledReply(APP, LABEL);
    expect(reply).toBe('Cancelled - Fill element in Wireframe. Nothing was changed.');
    expect(reply).toContain(LABEL);
    expect(reply).toContain(APP);
    expect(reply).toContain('Nothing was changed');
    expectPlainAscii(reply);
  });

  it("the cancelled copy does NOT contain the unknown-refusal wording", () => {
    const cancelled = orderCancelledReply(APP, LABEL);
    const refused = orderRefusedUnknownReply(APP);
    // The QA row (F-26) positively asserts this ABSENCE.
    expect(cancelled).not.toContain("couldn't");
    expect(cancelled).not.toContain("can't carry");
    expect(cancelled).not.toBe(refused);
    // And it is not silent.
    expect(cancelled.trim().length).toBeGreaterThan(0);
  });

  it('the unknown refusal names the app and does NOT borrow the app-OPEN "couldn\'t find" copy', () => {
    const refused = orderRefusedUnknownReply(APP);
    expect(refused).toBe("I can't carry out that order in Wireframe yet.");
    expect(refused).toContain(APP);
    // The app was found perfectly well — borrowing the open copy would lie.
    expect(refused).not.toContain('couldn\'t find');
    expectPlainAscii(refused);
  });

  it('an UNGROUNDED refusal (no app) is its own sentence naming the missing app', () => {
    const ungrounded = orderRefusedUnknownReply('');
    expect(ungrounded).toBe(
      "I can't carry out that order - there is no app in front of me yet.",
    );
    expect(ungrounded).toContain('no app');
    expect(ungrounded).not.toBe(orderRefusedUnknownReply(APP));
    expectPlainAscii(ungrounded);
  });

  it('the refusal and the cancellation differ from EACH OTHER in both directions', () => {
    // Two conditions, two subjects, two user next-actions (reword vs change of
    // mind) — so neither sentence may be substituted for the other.
    expect(orderRefusedUnknownReply(APP)).not.toContain('Cancelled');
    expect(orderCancelledReply(APP, LABEL)).not.toContain('yet.');
  });
});

describe('orderReply — AC-8: the irreversible warning is never empty', () => {
  it('names the action, the app and the declared consequence', () => {
    const warning = orderIrreversibleWarning(APP, LABEL, 'The document is discarded.');
    expect(warning).toContain(LABEL);
    expect(warning).toContain(APP);
    expect(warning).toContain('The document is discarded.');
    expect(warning).toContain('cannot be undone');
    expectPlainAscii(warning);
  });

  it('is NON-EMPTY even when the declared consequence is blank (a bare warning still warns)', () => {
    const warning = orderIrreversibleWarning(APP, LABEL, '   ');
    expect(warning.trim().length).toBeGreaterThan(0);
    expect(warning).toBe('This cannot be undone: Fill element in Wireframe.');
  });

  it('never claims undoability', () => {
    const warning = orderIrreversibleWarning(APP, LABEL, 'It is gone.');
    expect(warning).not.toContain('You can undo this');
  });
});

describe('orderReply — undo-with-nothing says so and never claims a success', () => {
  it('names the app, and the label when one is known', () => {
    expect(orderNothingToUndoReply(APP)).toBe('Nothing left to undo in Wireframe.');
    expect(orderNothingToUndoReply(APP, LABEL)).toBe(
      'Nothing left to undo for Fill element in Wireframe.',
    );
    expectPlainAscii(orderNothingToUndoReply(APP, LABEL));
  });

  it('does not contain any success wording', () => {
    for (const text of [orderNothingToUndoReply(APP), orderNothingToUndoReply(APP, LABEL)]) {
      expect(text).not.toContain('Undone -');
      expect(text.toLowerCase()).not.toContain('restored');
      expect(text.toLowerCase()).not.toContain('reverted');
    }
  });
});

describe('orderReply — the notices are the dialog copy source too', () => {
  it('states undoability as a bound datum, not a promise about registration', () => {
    expect(ORDER_UNDOABLE_NOTICE).toBe('You can undo this afterwards.');
    expect(ORDER_IRREVERSIBLE_NOTICE).toBe('This cannot be undone.');
    expectPlainAscii(ORDER_UNDOABLE_NOTICE);
    expectPlainAscii(ORDER_IRREVERSIBLE_NOTICE);
  });
});
