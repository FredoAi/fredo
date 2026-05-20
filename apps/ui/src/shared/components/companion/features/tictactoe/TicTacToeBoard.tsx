import React, { forwardRef } from 'react';
import { SimpleGrid, Box, Text } from '@chakra-ui/react';
import type { Board } from './useGameState';

interface TicTacToeBoardProps {
  board: Board;
  onCellClick: (index: number) => void;
  disabled?: boolean;
}

export const TicTacToeBoard = forwardRef<HTMLDivElement, TicTacToeBoardProps>(
  ({ board, onCellClick, disabled }, ref) => (
    <SimpleGrid ref={ref} columns={3} gap="2px" width="174px" flexShrink={0}>
      {board.map((cell, i) => (
        <Box
          key={i}
          width="56px"
          height="56px"
          display="flex"
          alignItems="center"
          justifyContent="center"
          border="1px solid"
          borderColor="whiteAlpha.300"
          borderRadius="sm"
          bg="blackAlpha.500"
          cursor={!cell && !disabled ? 'pointer' : 'default'}
          onClick={() => !cell && !disabled && onCellClick(i)}
          _hover={!cell && !disabled ? { bg: 'whiteAlpha.100' } : undefined}
          transition="background 0.1s"
        >
          <Text
            fontSize="2xl"
            fontWeight="bold"
            lineHeight="1"
            color={cell === 'X' ? 'blue.300' : 'red.400'}
          >
            {cell ?? ''}
          </Text>
        </Box>
      ))}
    </SimpleGrid>
  ),
);

TicTacToeBoard.displayName = 'TicTacToeBoard';
