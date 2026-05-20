import React from 'react';
import { chakra } from '@chakra-ui/react';
import { useAnimation, type AnimationType } from '../../../../shared/contexts/AnimationContext';

interface AnimationOption {
  value: AnimationType;
  label: string;
}

const animations: AnimationOption[] = [
  { value: 'random', label: 'Random' },
  { value: 'hyperspeed', label: 'Hyperspeed' },
  { value: 'magnet-lines', label: 'Magnet Lines' },
  { value: 'cubes', label: '3D Cubes' }
];

export const AnimationSelector: React.FC = () => {
  const { animationType: selected, setAnimationType } = useAnimation();

  const handleSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setAnimationType(e.target.value as AnimationType);
  };

  return (
    <chakra.select
      width="100%"
      p={2}
      borderRadius="md"
      bg="var(--card-bg)"
      border="1px solid"
      borderColor="var(--border-color)"
      color="var(--text-primary)"
      fontSize="sm"
      fontWeight="500"
      cursor="pointer"
      transition="all 0.2s"
      aria-label="Animation style"
      title="Animation style"
      value={selected}
      onChange={handleSelect}
      _hover={{
        borderColor: 'var(--accent-primary)'
      }}
      _focus={{
        outline: 'none',
        borderColor: 'var(--accent-primary)',
        boxShadow: '0 0 0 1px var(--accent-primary)'
      }}
    >
      {animations.map((animation) => (
        <option key={animation.value} value={animation.value}>
          {animation.label}
        </option>
      ))}
    </chakra.select>
  );
};
