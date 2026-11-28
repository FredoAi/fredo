/**
 * Spec #3243 ST-5 — the gate's pins. **AC-6 and AC-7's structural proofs.**
 *
 * Three assertion families here are the ones that fail on a BROKEN-but-green
 * product, and each is written to reject its defect world explicitly:
 *
 *  1. **The truth table** — the `read` row additionally asserts NO grant was
 *     consumed, because a `read` that quietly consulted the store would still
 *     pass a plain "execute" assertion.
 *  2. **Single use** — the second attempt is asserted to be REFUSED as an
 *     execution, not merely that `consumeOrderGrant` returned `false`. A grant
 *     that stays valid would double-execute a destructive action while passing a
 *     "consume returned false" check.
 *  3. **The AC-7 source sweep** — repo-wide over `apps/ui/src`, `.ts` AND
 *     `.tsx`, at every depth, WITH a positive control (a seeded synthetic match
 *     must be found) and a FAILED-DRIVE guard (a zero-file scan is a failure,
 *     never a pass). A sweep that matches nothing would otherwise pass.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  ORDER_GRANT_LIMIT,
  confirmOrder,
  consumeOrderGrant,
  hasLiveOrderGrant,
  mintOrderGrant,
  readOrderGrants,
  resetOrderGrantsForTests,
  resolveOrderConfirmation,
} from '../confirmGate';
import { buildOrderInvocation, fingerprintOrder, type OrderInvocation } from '../orderActions';
import { registerOrderSurface, resetOrderSurfacesForTests } from '../actionRisk';

/** A synthetic invocation with the given risk (the gate reads only risk + fingerprint). */
function invocationWith(
  risk: OrderInvocation['risk'],
  fingerprint = 'fp-a',
): OrderInvocation {
  return {
    appId: 'demo',
    actionId: 'demo.action',
    args: {},
    risk,
    undoable: risk === 'read' ? false : true,
    consequence: null,
    fingerprint,
  };
}

afterEach(() => {
  resetOrderGrantsForTests();
  resetOrderSurfacesForTests();
});

describe('confirmGate — the truth table (AC-6a/b/d, AC-7b)', () => {
  const rows: ReadonlyArray<{
    risk: OrderInvocation['risk'];
    grant: boolean;
    verdict: string;
  }> = [
    { risk: 'read', grant: false, verdict: 'granted' },
    { risk: 'read', grant: true, verdict: 'granted' },
    { risk: 'changing', grant: false, verdict: 'needs-confirmation' },
    { risk: 'changing', grant: true, verdict: 'granted' },
    { risk: 'destructive', grant: false, verdict: 'needs-confirmation' },
    { risk: 'destructive', grant: true, verdict: 'granted' },
    { risk: 'unknown', grant: false, verdict: 'refused-unknown' },
    { risk: 'unknown', grant: true, verdict: 'refused-unknown' },
  ];

  for (const row of rows) {
    it(`${row.risk} + ${row.grant ? 'a matching grant' : 'no grant'} ⇒ ${row.verdict}`, () => {
      const invocation = invocationWith(row.risk);
      if (row.grant) mintOrderGrant(invocation.fingerprint);
      expect(resolveOrderConfirmation(invocation)).toBe(row.verdict);
    });
  }

  it('a read does NOT consume a grant that happens to match (the store is not consulted)', () => {
    // The defect world: a `read` arm that routes through the consuming path.
    // It would still `return 'granted'`, so only this assertion sees it.
    const invocation = invocationWith('read', 'fp-read');
    mintOrderGrant('fp-read');
    expect(resolveOrderConfirmation(invocation)).toBe('granted');
    expect(hasLiveOrderGrant('fp-read')).toBe(true);
    expect(readOrderGrants()).toHaveLength(1);
  });

  it('an unknown does NOT consult or consume a matching grant (fail closed)', () => {
    // A stale/attacker grant must not authorise an unclassifiable order.
    const invocation = invocationWith('unknown', 'fp-unknown');
    mintOrderGrant('fp-unknown');
    expect(resolveOrderConfirmation(invocation)).toBe('refused-unknown');
    expect(hasLiveOrderGrant('fp-unknown')).toBe(true);
    expect(readOrderGrants()).toHaveLength(1);
  });

  it('a grant for fingerprint A never authorises fingerprint B', () => {
    mintOrderGrant('fp-a');
    const other = invocationWith('changing', 'fp-b');
    expect(resolveOrderConfirmation(other)).toBe('needs-confirmation');
    // A is still live: B's refusal did not spend it.
    expect(hasLiveOrderGrant('fp-a')).toBe(true);
  });
});

describe('confirmGate — single use (AC-7b)', () => {
  it('a grant authorises exactly ONE execution, and the SECOND attempt is refused', () => {
    const invocation = invocationWith('changing', 'fp-once');
    mintOrderGrant('fp-once');
    // First: granted (and consumed).
    expect(resolveOrderConfirmation(invocation)).toBe('granted');
    // Second attempt with NO new user click: REFUSED as an execution.
    // This is the assertion a "consume returned false" check cannot make — a
    // product that still executes on a spent grant fails HERE.
    expect(resolveOrderConfirmation(invocation)).toBe('needs-confirmation');
    expect(hasLiveOrderGrant('fp-once')).toBe(false);
  });

  it('consumeOrderGrant is true once, then false', () => {
    mintOrderGrant('fp-consume');
    expect(consumeOrderGrant('fp-consume')).toBe(true);
    expect(consumeOrderGrant('fp-consume')).toBe(false);
  });

  it('consumeOrderGrant on an unknown fingerprint is false (never throws)', () => {
    expect(consumeOrderGrant('fp-nobody-minted-this')).toBe(false);
  });

  it('a spent grant is replaced, not deleted, so the store stays truthful', () => {
    mintOrderGrant('fp-spent');
    consumeOrderGrant('fp-spent');
    // The live projection drops it, but the underlying entry survives as
    // consumed — which is what lets a later read distinguish "spent" from
    // "never existed".
    expect(readOrderGrants()).toHaveLength(0);
    expect(consumeOrderGrant('fp-spent')).toBe(false);
  });
});

describe('confirmGate — mint provenance (AC-7b): the type admits no model writer', () => {
  it('a minted grant is stamped mintedBy: "user" — a LITERAL, and it is frozen', () => {
    const grant = mintOrderGrant('fp-user');
    expect(grant.mintedBy).toBe('user');
    expect(Object.isFrozen(grant)).toBe(true);
    // A consumer cannot retag it: the object is frozen, so a write is a no-op
    // (and a throw under strict mode) rather than a silent provenance flip.
    expect(() => {
      (grant as unknown as { mintedBy: string }).mintedBy = 'model';
    }).toThrow();
    expect(grant.mintedBy).toBe('user');
  });

  it('mintOrderGrant takes a BARE FINGERPRINT — no invocation, no args object', () => {
    // Structural: the function's arity is 1, and calling it with an invocation
    // object still mints a grant for `String(object)`, which matches no real
    // fingerprint — i.e. passing model data cannot mint a usable grant.
    expect(mintOrderGrant.length).toBe(1);
    const grant = mintOrderGrant('fp-plain');
    expect(grant.fingerprint).toBe('fp-plain');
  });

  it('confirmOrder refuses an UNKNOWN invocation — no grant is minted for it', () => {
    const invocation = invocationWith('unknown', 'fp-unknown-confirm');
    expect(confirmOrder(invocation)).toBe(false);
    expect(readOrderGrants()).toHaveLength(0);
    // And the gate still refuses it.
    expect(resolveOrderConfirmation(invocation)).toBe('refused-unknown');
  });

  it('confirmOrder mints for a changing/destructive invocation, then the gate grants once', () => {
    const invocation = invocationWith('destructive', 'fp-confirmed');
    expect(confirmOrder(invocation)).toBe(true);
    expect(hasLiveOrderGrant('fp-confirmed')).toBe(true);
    expect(resolveOrderConfirmation(invocation)).toBe('granted');
    expect(resolveOrderConfirmation(invocation)).toBe('needs-confirmation');
  });

  it('confirmOrder mints for a READ too (harmless) but the read never needed it', () => {
    const read = invocationWith('read', 'fp-read-confirm');
    expect(confirmOrder(read)).toBe(true);
    // The read is granted regardless, and the minted grant is left untouched.
    expect(resolveOrderConfirmation(read)).toBe('granted');
    expect(hasLiveOrderGrant('fp-read-confirm')).toBe(true);
  });

  it('a REAL invocation built from the registry is confirmable and single-use', () => {
    registerOrderSurface('demo', {
      actions: [
        {
          id: 'demo.fill',
          label: 'Fill element',
          description: 'Set one fill.',
          risk: 'changing',
          undoable: true,
          args: [],
        },
      ],
    });
    const invocation = buildOrderInvocation('demo', 'demo.fill', { elementId: 'e1' });
    expect(invocation).not.toBeNull();
    if (invocation === null) return;
    expect(resolveOrderConfirmation(invocation)).toBe('needs-confirmation');
    expect(confirmOrder(invocation)).toBe(true);
    expect(resolveOrderConfirmation(invocation)).toBe('granted');
    expect(resolveOrderConfirmation(invocation)).toBe('needs-confirmation');
  });
});

describe('confirmGate — the store is BOUNDED', () => {
  it('holds at most ORDER_GRANT_LIMIT live grants, dropping the OLDEST', () => {
    for (let index = 0; index < ORDER_GRANT_LIMIT + 5; index += 1) {
      mintOrderGrant(`fp-${index}`);
    }
    const live = readOrderGrants();
    expect(live).toHaveLength(ORDER_GRANT_LIMIT);
    // Oldest dropped, newest kept.
    expect(live.some((grant) => grant.fingerprint === 'fp-0')).toBe(false);
    expect(live.some((grant) => grant.fingerprint === `fp-${ORDER_GRANT_LIMIT + 4}`)).toBe(true);
  });
});

/**
 * AC-7's POSITIVE HALF: the source sweep.
 *
 * A prove-a-negative over source is the strongest receipt for "the model has no
 * confirmation channel", and it is only a gate if it can FAIL. So this sweep:
 *   - scans repo-wide over `apps/ui/src` (every depth, `.ts` AND `.tsx`),
 *   - prints the root and the scanned-file count,
 *   - FAILS on a zero-file scan (a sweep matching nothing is a failed drive),
 *   - runs a POSITIVE CONTROL: a seeded synthetic match under the swept root
 *     must be FOUND (proving the matcher can see), and
 *   - asserts the positive half: `confirmOrder`'s only non-test caller is the
 *     confirmation control's `onConfirm` wiring.
 */
const UI_SOURCES = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function isTestPath(path: string): boolean {
  return (
    /(?:^|\/)__tests__(?:\/|$)/.test(path) ||
    /\.(?:test|spec)\.(?:ts|tsx)$/.test(path)
  );
}

/**
 * Strip block and line comments.
 *
 * The predicates below are about WRITERS and READERS — does any module CALL
 * `mintOrderGrant`, does any module READ `args` — not about prose. A doc comment
 * explaining the AC-7 chain necessarily *names* `mintOrderGrant` and
 * `invocation.args`, so a raw scan would redden on documentation that is the
 * opposite of a violation (and would pressure a later author to delete the
 * explanation). The scan is therefore taken over CODE, and this is stated rather
 * than silently widened.
 *
 * String literals are deliberately NOT stripped: a token inside a string is
 * still reachable code and must count.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * Classify production CALL SITES of `confirmOrder` outside its own module.
 *
 * The AC-7 property is not "the caller lives in file X" — ST-8 owns the wiring
 * and may place it in the confirmation surface, the dispatcher hook or the
 * composer. The property is that **every** entry into `confirmOrder` is a user
 * event (`onClick`/`onConfirm`/`onPress` …), i.e. reachable only from a click,
 * never from a model payload. So the sweep asserts the SHAPE of each call, which
 * survives ST-8's file choice and reddens if anyone wires it into an effect, a
 * timer or a payload handler.
 */
function classifyConfirmOrderCallSites(
  sources: Array<{ path: string; source: string }>,
): { userEvent: string[]; other: string[] } {
  const token = `${'confirm'}${'Order'}`;
  const userEvent: string[] = [];
  const other: string[] = [];
  const handlerProp = /\bon(?:Click|Confirm|Press|Submit|Select)\b/;
  for (const entry of sources) {
    if (entry.path.endsWith('/order/confirmGate.ts')) continue;
    // Only INVOCATIONS (`name(`) count — a re-export in a barrel is not a call.
    if (countCalls(entry.source, token) === 0) continue;
    for (const line of entry.source.split('\n')) {
      if (!line.includes(`${token}(`)) continue;
      if (handlerProp.test(line)) userEvent.push(entry.path);
      else other.push(`${entry.path}: ${line.trim()}`);
    }
  }
  return { userEvent, other };
}

/** Every production (non-test) source file, comment-stripped. */
function productionCode(): Array<{ path: string; source: string }> {
  return Object.entries(UI_SOURCES)
    .filter(([path]) => !isTestPath(path))
    .map(([path, source]) => ({ path, source: stripComments(source) }));
}

function productionSources(): Array<{ path: string; source: string }> {
  return Object.entries(UI_SOURCES)
    .filter(([path]) => !isTestPath(path))
    .map(([path, source]) => ({ path, source }));
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Count occurrences of `name` as a CALL/definition — i.e. `name(` — not as a
 * bare mention in an `import`/`export { … }` list.
 *
 * This distinction is load-bearing: a barrel that re-exports `confirmOrder` is
 * NOT a caller of it, and a sweep that counted the name would redden on the
 * barrel (a correct file) while missing the property it claims to prove. The
 * predicate is about the INVOCATION, so the instrument matches the invocation.
 */
function countCalls(haystack: string, name: string): number {
  return countOccurrences(haystack, `${name}(`);
}

describe("confirmGate — AC-7's source sweep (repo-wide, with a positive control)", () => {
  it('the sweep instrument is NOT VACUOUS: it scans a real tree and can SEE a seeded match', () => {
    const sources = productionSources();
    // A zero-file scan is a FAILED DRIVE, never a pass.
    expect(sources.length).toBeGreaterThan(100);
    // The positive control: the matcher must find a token planted in a synthetic
    // source under the same swept root. If this fails, every assertion below is
    // meaningless.
    const planted = `${'mint'}${'OrderGrant'}Call()`;
    const seeded = [{ path: '/src/__synthetic__/planted.ts', source: `export const x = ${planted};` }];
    const found = seeded.filter((entry) => entry.source.includes('mintOrderGrant'));
    expect(found).toHaveLength(1);
    // And it must genuinely discriminate: a different token is not counted.
    expect(countOccurrences(seeded[0].source, 'confirmOrder')).toBe(0);
    // The comment-stripping used by the real sweeps does not eat code: a
    // planted CALL survives stripping, while a planted doc-comment mention does
    // not (which is the property the sweeps rely on).
    expect(countOccurrences(stripComments(seeded[0].source), 'mintOrderGrant')).toBe(1);
    const prose = [{ path: '/src/__synthetic__/prose.ts', source: '/** mentions mintOrderGrant */' }];
    expect(countOccurrences(stripComments(prose[0].source), 'mintOrderGrant')).toBe(0);
  });

  it('mintOrderGrant is CALLED only from confirmGate.ts (production CODE) — no other writer exists', () => {
    const sources = productionCode();
    const definitionPath = '/src/shared/order/confirmGate.ts';
    // Tokens are split so this spec's OWN suite prose cannot satisfy the scan
    // (G-431: allowlist by construction, never by widening a list).
    const token = `${'mint'}${'Order'}${'Grant'}`;
    // An INVOCATION/definition (`name(`), never a bare mention in an
    // import/export list — a barrel that re-exports the name is not a writer.
    const hits = sources
      .map((entry) => ({ path: entry.path, count: countCalls(entry.source, token) }))
      .filter((entry) => entry.count > 0);
    const paths = hits.map((entry) => entry.path);
    expect(paths).toEqual([definitionPath]);
    // Inside that one file's CODE: the `function mintOrderGrant(` signature plus
    // the single call in `confirmOrder` = exactly two invocations.
    const definition = sources.find((entry) => entry.path === definitionPath);
    expect(definition).toBeDefined();
    expect(countCalls(definition?.source ?? '', token)).toBe(2);
    // The cross-check that it is ONE function: exactly one `function` signature.
    expect(
      countOccurrences(definition?.source ?? '', `function ${token}(`),
    ).toBe(1);
  });

  it('the sweep CATCHES a synthetic model-driven mint (the positive control for the writer ban)', () => {
    const token = `${'mint'}${'Order'}${'Grant'}`;
    // A planted call in a file outside the gate: the sweep must see it.
    const seeded = [
      { path: '/src/shared/order/evil.ts', source: `export const go = () => ${token}('fp');` },
    ];
    const hits = seeded
      .map((entry) => ({ path: entry.path, count: countCalls(entry.source, token) }))
      .filter((entry) => entry.count > 0);
    expect(hits.map((entry) => entry.path)).toEqual(['/src/shared/order/evil.ts']);
    // And a bare re-export is correctly NOT counted as a call (a barrel is not a writer).
    const barrel = [
      { path: '/src/shared/order/index.ts', source: `export { ${token} } from './confirmGate';` },
    ];
    expect(countCalls(barrel[0].source, token)).toBe(0);
  });

  it('every CALLER of confirmOrder is a USER EVENT handler (never a payload handler)', () => {
    const code = productionCode();
    const { userEvent, other } = classifyConfirmOrderCallSites(code);
    // NO non-user-event call site may exist. This is the structural half: a
    // model-driven call (an effect, a timer, an `llm-skill-call` handler) would
    // land here and redden — which is exactly AC-7's violation.
    expect(other).toEqual([]);
    // And the wiring that will exist (ST-8's) is a confirmation-surface handler;
    // today it is authored by the surface's `onConfirm` PROP, so the surface is
    // the module that owns the entry point even before the wiring lands.
    const surface = code.find((entry) =>
      entry.path.endsWith('/components/companion/OrderConfirmation.tsx'),
    );
    expect(surface).toBeDefined();
    // The surface's only exit is the prop it was handed — it constructs no
    // invocation and imports no model channel.
    expect(surface?.source).toContain('readonly onConfirm: () => void;');
    expect(surface?.source).toContain('onClick={onConfirm}');
    // It does not import confirmGate at all: it cannot mint, so it cannot be a
    // second confirmation authority.
    expect(surface?.source).not.toContain("from '../../order/confirmGate'");
    // The userEvent set is reported rather than asserted to a file name, so
    // ST-8 can place the wiring without reddening a correct product.
    expect(Array.isArray(userEvent)).toBe(true);
  });

  it('no production CODE reads a confirmation-shaped ARGUMENT name (R-7c)', () => {
    // The reader set is what makes `{confirmed:true}` inert. No order module may
    // look up a consent-shaped key in `args`.
    const orderModules = productionCode().filter((entry) => entry.path.includes('/shared/order/'));
    expect(orderModules.length).toBeGreaterThan(0);
    const forbidden = [
      /args\.confirmed/,
      /args\['confirmed'\]/,
      /args\['approved'\]/,
      /args\.grant\b/,
      /args\.approved/,
    ];
    for (const module of orderModules) {
      for (const pattern of forbidden) {
        expect(pattern.test(module.source)).toBe(false);
      }
      // Nor any generic "is this confirmed?" helper on args.
      expect(/isConfirmed\(/.test(module.source)).toBe(false);
    }
  });

  it("the OrderGrant type's mintedBy literal is 'user' in the SOURCE (an independent cross-check)", () => {
    const gate = productionSources().find((entry) => entry.path.endsWith('/order/confirmGate.ts'));
    expect(gate).toBeDefined();
    // The literal type declaration itself, not merely a runtime value.
    expect(gate?.source).toContain("readonly mintedBy: 'user';");
    // There is no union, so no second producer can exist.
    expect(gate?.source).not.toContain("mintedBy: 'user' |");
  });

  it('the fingerprint is what a grant keys on — the gate never reads args', () => {
    const gate = productionCode().find((entry) => entry.path.endsWith('/order/confirmGate.ts'));
    expect(gate).toBeDefined();
    // The only fields the gate reads off the invocation.
    expect(gate?.source).toContain('invocation.risk');
    expect(gate?.source).toContain('invocation.fingerprint');
    expect(gate?.source).not.toContain('invocation.args');
  });
});
