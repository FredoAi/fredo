/**
 * useSecretCode — a generic document-level secret-key-sequence host
 * (Spec #2970, ST-5).
 *
 * Mirrors `useKonamiCode` exactly (one mount-once `document.addEventListener
 * ('keydown', …)` with a stable handler reading the latest sequence/callback
 * through refs) but parameterized by the `sequence`. Matching is
 * case-insensitive and modifier-free, and keys originating inside an editable
 * control (`input` / `textarea` / `select` / `[contenteditable]`) are ignored so
 * ordinary typing can never hijack a field.
 *
 * It renders NOTHING and returns `void` — no indicator, hint, or live region
 * (secrecy). The typed `iddqd` trigger shows no companion bubble; the opened
 * `doom` window is the sole feedback.
 */
import { useCallback, useEffect, useRef } from 'react';

/** Whether a keydown originated inside a text-editable control. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useSecretCode(sequence: string, onComplete: () => void): void {
  // Keep the callback and the sequence in refs so changes never rebuild the
  // single document listener (the shipped `useKonamiCode` contract).
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const sequenceRef = useRef(sequence);
  useEffect(() => {
    sequenceRef.current = sequence;
  }, [sequence]);

  const indexRef = useRef(0);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    // Modifier-free only — never collide with a shortcut.
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    // Never hijack ordinary typing.
    if (isEditableTarget(event.target)) return;

    const seq = sequenceRef.current;
    if (seq.length === 0) return;

    const pressed = event.key.toLowerCase();
    const expected = seq[indexRef.current].toLowerCase();

    if (pressed === expected) {
      const next = indexRef.current + 1;
      if (next === seq.length) {
        indexRef.current = 0;
        onCompleteRef.current();
      } else {
        indexRef.current = next;
      }
      return;
    }

    // A mismatch resets the sequence; a mismatch that IS the first key starts a
    // fresh sequence from there (standard substring semantics).
    indexRef.current = pressed === seq[0].toLowerCase() ? 1 : 0;
  }, []); // stable — reads the latest sequence/callback through refs

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}
