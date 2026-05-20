import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Box, Text } from '@chakra-ui/react';

interface SpeechBubbleProps {
  message: string | null;
  companionX: number;
  companionY: number;
  companionWidth?: number;
  companionHeight?: number;
  color?: string;
  isStreaming?: boolean;
  children?: React.ReactNode;
}

// Fixed bubble dimensions — never resize during streaming.
const BUBBLE_W  = 240;
const BUBBLE_H  = 120;
const PAD       = 14;
const TAIL      = 10;
const MARGIN    = 8;
const GAP       = 10;
// Inner content area height (bubble minus top+bottom padding)
const CONTENT_H = BUBBLE_H - PAD * 2;

// Game bubble dimensions — larger to fit the TicTacToe board.
const GAME_W = 208;
const GAME_H = 268;

type Side = 'above' | 'below' | 'left' | 'right';

function chooseSide(cx: number, cy: number, cw: number, ch: number, bw: number, bh: number): Side {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const space: Record<Side, number> = {
    above: cy,
    below: vh - (cy + ch),
    left:  cx,
    right: vw - (cx + cw),
  };
  const needed: Record<Side, number> = {
    above: bh + TAIL + GAP,
    below: bh + TAIL + GAP,
    left:  bw + TAIL + GAP,
    right: bw + TAIL + GAP,
  };
  const ranked: Side[] = ['above', 'right', 'left', 'below'];
  return ranked.find(s => space[s] >= needed[s]) ?? 'above';
}

export const SpeechBubble: React.FC<SpeechBubbleProps> = ({
  message,
  companionX,
  companionY,
  companionWidth  = 80,
  companionHeight = 80,
  color = 'var(--accent-primary)',
  isStreaming = false,
  children,
}) => {
  const hasGame = Boolean(children);
  const bw = hasGame ? GAME_W : BUBBLE_W;
  const bh = hasGame ? GAME_H : BUBBLE_H;
  const cx = companionX;
  const cy = companionY;
  const cw = companionWidth;
  const ch = companionHeight;

  const side = chooseSide(cx, cy, cw, ch, bw, bh);

  let bubbleLeft = 0;
  let bubbleTop  = 0;

  if (side === 'above') {
    bubbleTop  = cy - bh - TAIL - GAP;
    bubbleLeft = cx + cw / 2 - bw / 2;
  } else if (side === 'below') {
    bubbleTop  = cy + ch + TAIL + GAP;
    bubbleLeft = cx + cw / 2 - bw / 2;
  } else if (side === 'right') {
    bubbleLeft = cx + cw + TAIL + GAP;
    bubbleTop  = cy + ch / 2 - bh / 2;
  } else {
    bubbleLeft = cx - bw - TAIL - GAP;
    bubbleTop  = cy + ch / 2 - bh / 2;
  }

  bubbleLeft = Math.max(MARGIN, Math.min(bubbleLeft, window.innerWidth  - bw - MARGIN));
  bubbleTop  = Math.max(MARGIN, Math.min(bubbleTop,  window.innerHeight - bh - MARGIN));

  const companionCX = cx + cw / 2;
  const companionCY = cy + ch / 2;
  const tailOnHoriz = side === 'above' || side === 'below';

  const tailOffsetX = tailOnHoriz
    ? Math.max(PAD + TAIL, Math.min(companionCX - bubbleLeft, BUBBLE_W - PAD - TAIL))
    : 0;
  const tailOffsetY = !tailOnHoriz
    ? Math.max(PAD + TAIL, Math.min(companionCY - bubbleTop, BUBBLE_H - PAD - TAIL))
    : 0;

  const initDelta = side === 'above' ? 6 : side === 'below' ? -6 : side === 'right' ? -6 : 6;

  return (
    <AnimatePresence>
      {(message || children) && (
        <motion.div
          // Key is stable while the bubble is open — only changes on open/close.
          // Using a static key prevents re-mounting (and jank) on every token.
          key="speech-bubble"
          initial={{ opacity: 0, scale: 0.88, y: initDelta }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.88, y: initDelta }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          style={{
            position: 'fixed',
            left: bubbleLeft,
            top: bubbleTop,
            width: bw,
            height: bh,
            zIndex: 101,
            pointerEvents: hasGame ? 'auto' : 'none',
          }}
        >
          <Box
            background="var(--card-bg)"
            border={`1.5px solid ${color}`}
            borderRadius="14px"
            padding={hasGame ? '0' : `${PAD}px`}
            boxShadow="0 4px 24px rgba(0,0,0,0.45)"
            position="relative"
            width="100%"
            height="100%"
            overflow={hasGame ? 'visible' : 'hidden'}
          >
            {hasGame ? (
              children
            ) : (
              /* Fixed-height text area — no layout shift during streaming */
              <Box height={`${CONTENT_H}px`} overflow="hidden" position="relative">
                <Text
                  fontFamily='"Fira Mono", monospace'
                  fontSize="12px"
                  lineHeight="19px"
                  color="var(--text-primary)"
                  whiteSpace="pre-wrap"
                >
                  {message}
                  {isStreaming && (
                    <Box
                      as="span"
                      display="inline-block"
                      width="2px"
                      height="14px"
                      background={color}
                      marginLeft="1px"
                      verticalAlign="middle"
                      animation="Fredo-cursor-blink 0.9s step-end infinite"
                    />
                  )}
                </Text>
              </Box>
            )}

            {side === 'above' && (
              <Box position="absolute" bottom={`-${TAIL}px`} left={`${tailOffsetX}px`} transform="translateX(-50%)"
                width="0" height="0"
                borderTop={`${TAIL}px solid ${color}`}
                borderLeft={`${TAIL}px solid transparent`}
                borderRight={`${TAIL}px solid transparent`}
              />
            )}
            {side === 'below' && (
              <Box position="absolute" top={`-${TAIL}px`} left={`${tailOffsetX}px`} transform="translateX(-50%)"
                width="0" height="0"
                borderBottom={`${TAIL}px solid ${color}`}
                borderLeft={`${TAIL}px solid transparent`}
                borderRight={`${TAIL}px solid transparent`}
              />
            )}
            {side === 'right' && (
              <Box position="absolute" left={`-${TAIL}px`} top={`${tailOffsetY}px`} transform="translateY(-50%)"
                width="0" height="0"
                borderRight={`${TAIL}px solid ${color}`}
                borderTop={`${TAIL}px solid transparent`}
                borderBottom={`${TAIL}px solid transparent`}
              />
            )}
            {side === 'left' && (
              <Box position="absolute" right={`-${TAIL}px`} top={`${tailOffsetY}px`} transform="translateY(-50%)"
                width="0" height="0"
                borderLeft={`${TAIL}px solid ${color}`}
                borderTop={`${TAIL}px solid transparent`}
                borderBottom={`${TAIL}px solid transparent`}
              />
            )}
          </Box>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
