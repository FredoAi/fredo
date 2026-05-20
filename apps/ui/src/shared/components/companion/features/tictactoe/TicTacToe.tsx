import React, { useRef, useCallback, useState } from 'react';
import { Box, Text, Button, VStack } from '@chakra-ui/react';
import { TicTacToeBoard } from './TicTacToeBoard';
import { useGameState } from './useGameState';
import { adapterBridge } from '../../../../utils/adapterBridge';
import type { LlmMessage } from '../../../../../app/adapters/HostAdapter';
import './tictactoe.css';

const SYSTEM_PROMPT =
  'You are playing Tic-Tac-Toe as O. The board image shows the current state. ' +
  'Cells are numbered 0-8, left to right then top to bottom ' +
  '(row 0: cells 0,1,2 — row 1: cells 3,4,5 — row 2: cells 6,7,8). ' +
  'X is your opponent. Pick the best available empty cell. ' +
  'Reply with ONLY a single digit 0-8. No explanation, no other text.';

interface TicTacToeProps {
  onStreamingMessage: (msg: string | null) => void;
  onStartStreaming: () => void;
  onDoneStreaming: () => void;
}

export const TicTacToe: React.FC<TicTacToeProps> = ({
  onStreamingMessage,
  onStartStreaming,
  onDoneStreaming,
}) => {
  const boardRef = useRef<HTMLDivElement>(null);
  const { board, currentTurn, winner, makePlayerMove, makeCompanionMove, reset } = useGameState();
  const [isCompanionThinking, setIsCompanionThinking] = useState(false);

  const triggerCompanionMove = useCallback(async () => {
    if (!boardRef.current) return;
    setIsCompanionThinking(true);
    onStartStreaming();
    onStreamingMessage('🤔 Analyzing board...');

    try {
      // Compute physical screen coordinates of the board element.
      const rect = boardRef.current.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const sx = Math.round((window.screenX + rect.left) * dpr);
      const sy = Math.round((window.screenY + rect.top) * dpr);
      const sw = Math.round(rect.width * dpr);
      const sh = Math.round(rect.height * dpr);

      const imageBase64 = await adapterBridge.invoke<string>('capture_screen_region', {
        x: sx,
        y: sy,
        width: sw,
        height: sh,
      });

      if (!imageBase64) throw new Error('capture_screen_region returned no data');

      const messages: LlmMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: 'Look at the board and tell me your move (single digit 0-8).',
        },
      ];

      let accumulated = '';
      onStreamingMessage('');

      await adapterBridge.llmChatWithImage(
        messages,
        imageBase64,
        (token) => {
          accumulated += token;
          onStreamingMessage(accumulated);
        },
        () => {
          // Parse the first digit in the model's response.
          const match = accumulated.match(/\d/);
          if (match) {
            const idx = parseInt(match[0], 10);
            if (idx >= 0 && idx <= 8 && board[idx] === null) {
              makeCompanionMove(idx);
            } else {
              // Fallback: first empty cell.
              const fallback = board.findIndex((c) => c === null);
              if (fallback !== -1) makeCompanionMove(fallback);
            }
          } else {
            const fallback = board.findIndex((c) => c === null);
            if (fallback !== -1) makeCompanionMove(fallback);
          }
          setIsCompanionThinking(false);
          onDoneStreaming();
        },
      );
    } catch (err) {
      console.error('[TicTacToe] companion move error:', err);
      onStreamingMessage('(error — picking random move)');
      const fallback = board.findIndex((c) => c === null);
      if (fallback !== -1) makeCompanionMove(fallback);
      setIsCompanionThinking(false);
      onDoneStreaming();
    }
  }, [board, makeCompanionMove, onStreamingMessage, onStartStreaming, onDoneStreaming]);

  const handleCellClick = useCallback(
    (index: number) => {
      if (isCompanionThinking || winner) return;
      const companionShouldMove = makePlayerMove(index);
      if (companionShouldMove) {
        // Wait one frame so React re-renders the X before taking the screenshot.
        setTimeout(triggerCompanionMove, 200);
      }
    },
    [isCompanionThinking, winner, makePlayerMove, triggerCompanionMove],
  );

  const statusText = winner
    ? winner === 'draw'
      ? "It's a draw!"
      : winner === 'X'
        ? 'You win! 🎉'
        : 'Companion wins!'
    : isCompanionThinking
      ? 'Companion is thinking…'
      : currentTurn === 'X'
        ? 'Your turn (X)'
        : "Companion's turn (O)";

  return (
    <VStack gap={2} align="center" className="tictactoe-container">
      <Text fontSize="xs" fontWeight="semibold" color="whiteAlpha.800" textAlign="center">
        {statusText}
      </Text>
      <TicTacToeBoard
        ref={boardRef}
        board={board}
        onCellClick={handleCellClick}
        disabled={isCompanionThinking || currentTurn !== 'X' || !!winner}
      />
      {winner && (
        <Button size="xs" onClick={reset} variant="outline" color="whiteAlpha.700" borderColor="whiteAlpha.300" _hover={{ bg: 'whiteAlpha.100', borderColor: 'whiteAlpha.500', color: 'white' }}>
          Play again
        </Button>
      )}
    </VStack>
  );
};
