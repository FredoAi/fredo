import { useEffect, useState, useCallback, useRef } from 'react';

const KONAMI_CODE = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'b',
  'a',
];

export const useKonamiCode = (onComplete: () => void) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [halfwayComplete, setHalfwayComplete] = useState(false);

  // Keep onComplete in a ref so changes don't rebuild the keydown listener
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  // currentIndex ref mirrors state so the single stable handler always reads the latest value
  const currentIndexRef = useRef(currentIndex);
  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
  const halfwayCompleteRef = useRef(halfwayComplete);
  useEffect(() => { halfwayCompleteRef.current = halfwayComplete; }, [halfwayComplete]);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    const idx = currentIndexRef.current;
    const expectedKey = KONAMI_CODE[idx];
    const pressedKey = event.key;

    if (pressedKey === expectedKey) {
      const newIndex = idx + 1;

      if (newIndex === 5 && !halfwayCompleteRef.current) {
        setHalfwayComplete(true);
      }

      if (newIndex === KONAMI_CODE.length) {
        onCompleteRef.current();
        setCurrentIndex(0);
        setHalfwayComplete(false);
      } else {
        setCurrentIndex(newIndex);
      }
    } else {
      setCurrentIndex(0);
      setHalfwayComplete(false);
    }
  }, []); // stable — reads latest values through refs

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  return { halfwayComplete };
};
