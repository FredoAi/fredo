import React, { useMemo } from 'react';
import { Box, Text, Flex } from '@chakra-ui/react';
import { EMPTY_STATE_JOKES } from '../lib/contract';

/**
 * Retro-futuristic empty state for Mission Monitor.
 *
 * Renders when no deliveries exist for the chat-node contract.
 * Randomly selects one of three agentic workspace jokes on mount.
 * Uses Fredo theme tokens exclusively — no hardcoded hex colors.
 */
export const EmptyState: React.FC = () => {
  const joke = useMemo(() => {
    const idx = Math.floor(Math.random() * EMPTY_STATE_JOKES.length);
    return EMPTY_STATE_JOKES[idx];
  }, []);

  return (
    <Flex
      direction="column"
      align="center"
      justify="center"
      height="100%"
      width="100%"
      p={8}
      gap={6}
      animation="mission-monitor-fade-in 0.6s ease-out"
    >
      <style>{`
        @keyframes mission-monitor-fade-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes mission-monitor-pulse {
          0%, 100% { opacity: 0.3; transform: translate(-50%, -50%) scale(1); }
          50%      { opacity: 0.7; transform: translate(-50%, -50%) scale(1.3); }
        }
      `}</style>

      {/* Retro-futuristic terminal illustration */}
      <Box
        position="relative"
        width="160px"
        height="120px"
        opacity={0.35}
      >
        {/* Outer screen frame */}
        <Box
          position="absolute"
          inset={0}
          border="1px solid"
          borderColor="accent.default"
          borderRadius="md"
          opacity={0.6}
        />
        {/* Inner scan-line grid */}
        <Box
          position="absolute"
          top="8px"
          left="8px"
          right="8px"
          bottom="8px"
          overflow="hidden"
          bg="bg.canvas"
          css={{
            backgroundImage:
              'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(99,102,241,0.04) 2px, rgba(99,102,241,0.04) 4px)',
          }}
        >
          {/* Agent pulse dot */}
          <Box
            position="absolute"
            top="50%"
            left="50%"
            width="12px"
            height="12px"
            borderRadius="full"
            bg="accent.default"
            animation="mission-monitor-pulse 2s ease-in-out infinite"
            style={{
              transform: 'translate(-50%, -50%)',
              boxShadow: '0 0 12px var(--accent-primary)',
            }}
          />
          {/* Corner brackets */}
          <Text
            position="absolute"
            top="2px"
            left="4px"
            fontSize="10px"
            fontFamily="fonts.mono"
            color="accent.default"
            opacity={0.5}
          >
            {'[>_'}
          </Text>
          <Text
            position="absolute"
            bottom="2px"
            right="4px"
            fontSize="10px"
            fontFamily="fonts.mono"
            color="accent.default"
            opacity={0.3}
          >
            {'_<]'}
          </Text>
        </Box>
      </Box>

      {/* Headline */}
      <Text
        fontSize="md"
        fontWeight={600}
        color="fg.default"
        textAlign="center"
        letterSpacing="0.02em"
      >
        No Agent Sessions Yet
      </Text>

      {/* Joke */}
      <Text
        fontSize="sm"
        color="fg.muted"
        textAlign="center"
        maxWidth="380px"
        lineHeight={1.6}
        fontFamily="fonts.mono"
        fontStyle="italic"
      >
        "{joke}"
      </Text>

      {/* Subdued instruction */}
      <Text
        fontSize="xs"
        color="fg.muted"
        textAlign="center"
        mt={2}
        opacity={0.5}
      >
        Start an agent session or connect an OpenCode provider to see activity here.
      </Text>
    </Flex>
  );
};

export default EmptyState;
