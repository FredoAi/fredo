import React, { useState, useEffect, useCallback } from 'react';
import { Box, VStack, Text, Heading } from '@chakra-ui/react';
import { motion } from 'framer-motion';
import MagnetLines from '../../../shared/components/animations/MagnetLines';
import Cubes from '../../../shared/components/animations/Cubes';
import Hyperspeed from '../../../shared/components/animations/Hyperspeed';
import { useKonamiCode } from '../../../shared/hooks/useKonamiCode';
import { useAnimation } from '../../../shared/contexts/AnimationContext';

const MotionBox = motion.create(Box);

interface DesktopBackgroundProps {
  onKonamiCode?: () => void;
}

export const DesktopBackground: React.FC<DesktopBackgroundProps> = ({ onKonamiCode }) => {
  const { animationType } = useAnimation();
  const [randomAnimation, setRandomAnimation] = useState<'hyperspeed' | 'magnet-lines' | 'cubes'>('hyperspeed');

  const handleKonami = useCallback(() => {
    onKonamiCode?.();
  }, [onKonamiCode]);

  const { halfwayComplete } = useKonamiCode(handleKonami);

  useEffect(() => {
    if (animationType === 'random') pickRandomAnimation();
  }, [animationType]);

  const pickRandomAnimation = () => {
    const options = ['hyperspeed', 'magnet-lines', 'cubes'] as const;
    setRandomAnimation(options[Math.floor(Math.random() * options.length)]);
  };

  const currentAnimation = animationType === 'random' ? randomAnimation : animationType;

  return (
    <Box
      position="absolute"
      inset="0"
      bg="var(--body-bg)"
      color="var(--text-primary)"
      overflow="hidden"
      zIndex={0}
      boxShadow={halfwayComplete ? '0 0 20px var(--purple-500), inset 0 0 20px var(--purple-500)' : 'none'}
      transition="box-shadow 0.5s ease-in-out"
    >
      {/* Animated Background */}
      <Box position="absolute" inset="0" zIndex={0}>
        {currentAnimation === 'hyperspeed' && <Hyperspeed />}
        {currentAnimation === 'magnet-lines' && <MagnetLines />}
        {currentAnimation === 'cubes' && <Cubes />}
      </Box>

      {/* Dark overlay to dim the animation and improve text contrast */}
      <Box
        id="lights"
        position="absolute"
        inset="0"
        zIndex={0}
        style={{ backgroundImage: 'linear-gradient(rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.2))' }}
        pointerEvents="none"
      />

      {/* Branding overlay — centered, no interactive elements */}
      <Box
        position="absolute"
        inset="0"
        zIndex={1}
        display="flex"
        alignItems="center"
        justifyContent="center"
        pointerEvents="none"
      >
        <MotionBox
          textAlign="center"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          px={10}
          py={6}
          borderRadius="2xl"
          style={{
            background: 'rgba(0, 0, 0, 0.35)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            boxShadow: '0 4px 32px rgba(0,0,0,0.4)',
          }}
        >
          <VStack gap={4}>
            <MotionBox
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.6, delay: 0.2 }}
            >
              <Heading
                as="h1"
                fontSize={{ base: '3xl', sm: '4xl', md: '5xl', lg: '5xl', xl: '6xl' }}
                fontWeight="normal"
                fontFamily="var(--font-primary)"
                color="white"
                letterSpacing="wide"
              >
                Fredo
              </Heading>
            </MotionBox>
          </VStack>
        </MotionBox>
      </Box>
    </Box>
  );
};
