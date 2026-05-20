import React from 'react';
import { Box, Text, VStack, Button } from '@chakra-ui/react';

interface ErrorDisplayProps {
  message: string;
  onRetry?: () => void;
}

export const ErrorDisplay: React.FC<ErrorDisplayProps> = ({ message, onRetry }) => {
  return (
    <Box 
      display="flex" 
      alignItems="center" 
      justifyContent="center" 
      height="100vh"
      width="100%"
    >
      <VStack gap={4}>
        <Text color="red.500" fontSize="lg" fontWeight="bold">
          Error
        </Text>
        <Text color="gray.600" textAlign="center" maxWidth="md">
          {message}
        </Text>
        {onRetry && (
          <Button onClick={onRetry} colorPalette="blue">
            Retry
          </Button>
        )}
      </VStack>
    </Box>
  );
};
