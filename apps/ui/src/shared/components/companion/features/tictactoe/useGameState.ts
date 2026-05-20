import { useState, useCallback } from 'react';

export type Player = 'X' | 'O';
export type Cell = Player | null;
export type Board = [Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell];

const WINNING_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function checkWinner(board: Board): Player | 'draw' | null {
  for (const [a, b, c] of WINNING_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a] as Player;
    }
  }
  if (board.every((c) => c !== null)) return 'draw';
  return null;
}

export function useGameState() {
  const [board, setBoard] = useState<Board>(Array(9).fill(null) as Board);
  const [currentTurn, setCurrentTurn] = useState<Player>('X');
  const [winner, setWinner] = useState<Player | 'draw' | null>(null);

  /** Place X on `index`. Returns true if the companion should now move. */
  const makePlayerMove = useCallback(
    (index: number): boolean => {
      if (board[index] || winner || currentTurn !== 'X') return false;
      const next = [...board] as Board;
      next[index] = 'X';
      setBoard(next);
      const w = checkWinner(next);
      if (w) {
        setWinner(w);
        return false;
      }
      setCurrentTurn('O');
      return true;
    },
    [board, winner, currentTurn],
  );

  /** Place O on `index` (companion's move). */
  const makeCompanionMove = useCallback(
    (index: number) => {
      setBoard((prev) => {
        if (prev[index] !== null) return prev;
        const next = [...prev] as Board;
        next[index] = 'O';
        const w = checkWinner(next);
        if (w) setWinner(w);
        else setCurrentTurn('X');
        return next;
      });
    },
    [],
  );

  const reset = useCallback(() => {
    setBoard(Array(9).fill(null) as Board);
    setCurrentTurn('X');
    setWinner(null);
  }, []);

  return { board, currentTurn, winner, makePlayerMove, makeCompanionMove, reset };
}
