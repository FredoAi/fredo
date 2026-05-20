import React from 'react';
import { Box, Spinner, Text, VStack } from '@chakra-ui/react';

interface LoadingProps {
  message?: string;
}

export const Loading: React.FC<LoadingProps> = ({ message = 'Loading...' }) => {
  return (
    <Box 
      display="flex" 
      alignItems="center" 
      justifyContent="center" 
      height="100vh"
      width="100%"
    >
      <VStack gap={4}>
        <Spinner 
          size="xl" 
          colorPalette="blue"
        />
        <Text color="gray.600">{message}</Text>
      </VStack>
    </Box>
  );
};
