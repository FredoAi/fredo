/**
 * Spec #3243 ST-5 — the confirmation surface's pins.
 *
 * The load-bearing assertion is the ROOT'S **COMPUTED** ACCESSIBLE NAME
 * (ADJ-12). It is read through the accessibility tree, never through the
 * presence of an `aria-label` attribute, because an `aria-label` on the root
 * would produce the same name while ERASING the verb, the target, the
 * undoability statement and the irreversible warning from a screen-reader user.
 * A pin written as "the root has `aria-label`" would force that defect.
 *
 * The supporting pins state the rest of the surface's contract: the testid set,
 * both control names, the `data-order-undoable` discriminator, Cancel-first
 * focus, no scrim confirmation, and NO `aria-live` region (the ONE polite
 * region in the product stays the companion entity's).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';

import {
  ORDER_CONFIRMATION_CANCEL_LABEL,
  ORDER_CONFIRMATION_CANCEL_TESTID,
  ORDER_CONFIRMATION_CONFIRM_TESTID,
  ORDER_CONFIRMATION_CONSEQUENCE_TESTID,
  ORDER_CONFIRMATION_TESTID,
  ORDER_CONFIRMATION_TITLE,
  ORDER_CONFIRMATION_VERB_TESTID,
  OrderConfirmation,
  orderConfirmationConfirmLabel,
} from '../OrderConfirmation';
import type { OrderInvocation } from '../../../order/orderActions';

const APP = 'Wireframe';
const LABEL = 'Fill element';

function invocation(overrides: Partial<OrderInvocation> = {}): OrderInvocation {
  return {
    appId: 'wireframe',
    actionId: 'wireframe.element.fill',
    args: {},
    risk: 'changing',
    undoable: true,
    consequence: null,
    fingerprint: 'fp-test',
    ...overrides,
  };
}

const IRREVERSIBLE: OrderInvocation = invocation({
  actionId: 'wireframe.document.new',
  risk: 'destructive',
  undoable: false,
  consequence: 'The current unsaved wireframe is discarded.',
  fingerprint: 'fp-new',
});

function renderConfirmation(
  target: OrderInvocation | null = invocation(),
  handlers: { onConfirm?: () => void; onCancel?: () => void } = {},
) {
  return renderWithChakra(
    <OrderConfirmation
      invocation={target}
      appName={APP}
      label={LABEL}
      onConfirm={handlers.onConfirm ?? (() => {})}
      onCancel={handlers.onCancel ?? (() => {})}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe('OrderConfirmation — nothing to confirm renders nothing', () => {
  it('renders nothing for a null invocation', () => {
    renderConfirmation(null);
    expect(screen.queryByTestId(ORDER_CONFIRMATION_TESTID)).toBeNull();
  });
});

describe('OrderConfirmation — the published testid set and the dialog role', () => {
  it('renders the root as a modal dialog with every published testid present', async () => {
    renderConfirmation();
    const root = await screen.findByTestId(ORDER_CONFIRMATION_TESTID);
    expect(root).toHaveAttribute('role', 'dialog');
    expect(root).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId(ORDER_CONFIRMATION_VERB_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId(ORDER_CONFIRMATION_CONSEQUENCE_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId(ORDER_CONFIRMATION_CONFIRM_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId(ORDER_CONFIRMATION_CANCEL_TESTID)).toBeInTheDocument();
  });
});

describe('OrderConfirmation — the root is named from its SUBTREE (ADJ-12)', () => {
  it('the COMPUTED accessible name is exactly `Confirm this order`', async () => {
    renderConfirmation();
    const root = await screen.findByTestId(ORDER_CONFIRMATION_TESTID);
    // The computed name — this is what the QA row reads, and what an
    // `aria-label` implementation would still pass while hiding the subtree.
    expect(root).toHaveAccessibleName(ORDER_CONFIRMATION_TITLE);
  });

  it('the name comes from aria-labelledby and the root carries NO aria-label', async () => {
    renderConfirmation();
    const root = await screen.findByTestId(ORDER_CONFIRMATION_TESTID);
    const labelId = root.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    // The referenced node's text IS the contract string.
    const title = labelId === null ? null : document.getElementById(labelId);
    expect(title?.textContent).toBe(ORDER_CONFIRMATION_TITLE);
    // The defect this forbids: an aria-label on the root.
    expect(root).not.toHaveAttribute('aria-label');
  });

  it('the name is DERIVED from the labelled element, not carried by a literal', async () => {
    // The trap this pin exists to escape: with `aria-label` on the root the
    // COMPUTED NAME is the same string, so a naive `toHaveAccessibleName` check
    // cannot tell the correct implementation from the defect. The discriminating
    // fact is DERIVATION — detach the `aria-labelledby` target and a derived name
    // disappears, while a literal `aria-label` survives.
    renderConfirmation();
    const root = await screen.findByTestId(ORDER_CONFIRMATION_TESTID);
    const labelId = root.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    const title = labelId === null ? null : document.getElementById(labelId);
    expect(title).not.toBeNull();
    // Remove the name source from the tree.
    title?.remove();
    // A DERIVED name is now empty; an `aria-label` would still answer.
    expect(root).not.toHaveAccessibleName(ORDER_CONFIRMATION_TITLE);
  });

  it('the subtree stays EXPOSED — the verb and the app are inside the named root', async () => {
    // With an `aria-label` on the root, these would still be in the DOM but the
    // root's own accessible name would replace them for a screen-reader user.
    renderConfirmation();
    const root = await screen.findByTestId(ORDER_CONFIRMATION_TESTID);
    expect(root).toContainElement(screen.getByTestId(ORDER_CONFIRMATION_VERB_TESTID));
    expect(screen.getByTestId(ORDER_CONFIRMATION_VERB_TESTID)).toHaveTextContent(LABEL);
    expect(root).toHaveTextContent(`in ${APP}`);
  });
});

describe('OrderConfirmation — both control names stand alone', () => {
  it("the confirm control's name is `Run <label>` and its visible text equals it", async () => {
    renderConfirmation();
    const confirm = await screen.findByTestId(ORDER_CONFIRMATION_CONFIRM_TESTID);
    expect(confirm).toHaveAccessibleName(orderConfirmationConfirmLabel(LABEL));
    expect(confirm).toHaveAccessibleName('Run Fill element');
    expect(confirm.textContent).toBe('Run Fill element');
    // No aria-label: the text IS the name (an aria-label would erase it).
    expect(confirm).not.toHaveAttribute('aria-label');
  });

  it('the cancel control is named `Cancel`', async () => {
    renderConfirmation();
    const cancel = await screen.findByTestId(ORDER_CONFIRMATION_CANCEL_TESTID);
    expect(cancel).toHaveAccessibleName(ORDER_CONFIRMATION_CANCEL_LABEL);
    expect(ORDER_CONFIRMATION_CANCEL_LABEL).toBe('Cancel');
  });
});

describe('OrderConfirmation — the undoable / irreversible variants (AC-8)', () => {
  it('an UNDOABLE action carries data-order-undoable="true" and states undoability', async () => {
    renderConfirmation();
    const root = await screen.findByTestId(ORDER_CONFIRMATION_TESTID);
    expect(root).toHaveAttribute('data-order-undoable', 'true');
    expect(screen.getByTestId(ORDER_CONFIRMATION_CONSEQUENCE_TESTID)).toHaveTextContent(
      'You can undo this afterwards.',
    );
  });

  it('an IRREVERSIBLE action carries data-order-undoable="false" and renders the warning', async () => {
    renderConfirmation(IRREVERSIBLE);
    const root = await screen.findByTestId(ORDER_CONFIRMATION_TESTID);
    expect(root).toHaveAttribute('data-order-undoable', 'false');
    const consequence = screen.getByTestId(ORDER_CONFIRMATION_CONSEQUENCE_TESTID);
    // The warning names the action, the app AND the declared consequence.
    expect(consequence).toHaveTextContent('This cannot be undone');
    expect(consequence).toHaveTextContent(LABEL);
    expect(consequence).toHaveTextContent(APP);
    expect(consequence).toHaveTextContent('The current unsaved wireframe is discarded.');
  });

  it('the warning is SEPARATE exposed text — never inside a control', async () => {
    renderConfirmation(IRREVERSIBLE);
    const confirm = await screen.findByTestId(ORDER_CONFIRMATION_CONFIRM_TESTID);
    const cancel = screen.getByTestId(ORDER_CONFIRMATION_CANCEL_TESTID);
    const consequence = screen.getByTestId(ORDER_CONFIRMATION_CONSEQUENCE_TESTID);
    // So no control's `aria-label` can hide it.
    expect(confirm).not.toContainElement(consequence);
    expect(cancel).not.toContainElement(consequence);
  });

  it('the two variants are distinguishable WITHOUT colour (text + attribute + an alert icon)', async () => {
    const { unmount } = renderConfirmation();
    const undoableText =
      screen.getByTestId(ORDER_CONFIRMATION_CONSEQUENCE_TESTID).textContent ?? '';
    const undoableRoot = screen.getByTestId(ORDER_CONFIRMATION_TESTID);
    expect(undoableRoot).toHaveAttribute('data-order-undoable', 'true');
    unmount();

    renderConfirmation(IRREVERSIBLE);
    const irreversibleText =
      screen.getByTestId(ORDER_CONFIRMATION_CONSEQUENCE_TESTID).textContent ?? '';
    const irreversibleRoot = screen.getByTestId(ORDER_CONFIRMATION_TESTID);
    expect(irreversibleRoot).toHaveAttribute('data-order-undoable', 'false');
    // A theme-blind reading still separates them.
    expect(irreversibleText).not.toBe(undoableText);
    expect(irreversibleText).toContain('cannot be undone');
  });
});

describe('OrderConfirmation — the safety interaction contract (AC-7)', () => {
  it('initial focus lands on CANCEL, never on Confirm', async () => {
    renderConfirmation();
    await waitFor(() => expect(screen.getByTestId(ORDER_CONFIRMATION_CANCEL_TESTID)).toHaveFocus());
    expect(screen.getByTestId(ORDER_CONFIRMATION_CONFIRM_TESTID)).not.toHaveFocus();
  });

  it('the confirm click is the ONLY exit that confirms, exactly once', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderConfirmation(invocation(), { onConfirm, onCancel });
    fireEvent.click(await screen.findByTestId(ORDER_CONFIRMATION_CONFIRM_TESTID));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('the cancel control calls onCancel and NEVER onConfirm', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderConfirmation(invocation(), { onConfirm, onCancel });
    fireEvent.click(await screen.findByTestId(ORDER_CONFIRMATION_CANCEL_TESTID));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('no auto-confirm: opening the dialog confirms nothing', async () => {
    const onConfirm = vi.fn();
    renderConfirmation(invocation(), { onConfirm });
    await screen.findByTestId(ORDER_CONFIRMATION_TESTID);
    // A safety dialog must never open already-answered.
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('the confirm control carries NO keyboard shortcut binding (no second confirm path)', async () => {
    renderConfirmation();
    const confirm = await screen.findByTestId(ORDER_CONFIRMATION_CONFIRM_TESTID);
    // No accessKey, no key handler on the control itself.
    expect(confirm).not.toHaveAttribute('accesskey');
    expect(confirm.getAttribute('aria-keyshortcuts')).toBeNull();
  });
});

describe('OrderConfirmation — it adds NO second announcement channel', () => {
  it('declares no aria-live region anywhere in the subtree', async () => {
    const { container } = renderConfirmation(IRREVERSIBLE);
    await screen.findByTestId(ORDER_CONFIRMATION_TESTID);
    // The ONE polite region in the product stays the companion entity's; this
    // dialog is announced by focus entering a `dialog`, a different mechanism.
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });
});
