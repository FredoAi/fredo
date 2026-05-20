import React, { useState, useEffect } from 'react';
import { Box, VStack, HStack, Text, Heading, Table, IconButton, Textarea, Button } from '@chakra-ui/react';
import { toaster } from '../../../shared/components/ui/toaster';
import { motion } from 'framer-motion';
import { LuCopy, LuPencil, LuPlay, LuX } from 'react-icons/lu';
import { TOAST_DURATION } from '../../../shared/constants';
import { QUERY_ENDPOINTS } from '../constants';

const MotionBox = motion(Box);

interface QueryViewerProps {
  query: string;
  results: any[];
  toolName?: string;
  executionTime?: number;
}

const QueryViewerComponent: React.FC<QueryViewerProps> = ({ query, results, toolName = 'Query', executionTime }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [currentQuery, setCurrentQuery] = useState(query);
  const [editedQuery, setEditedQuery] = useState(query);
  const [isExecuting, setIsExecuting] = useState(false);
  const [currentResults, setCurrentResults] = useState(results);
  const [currentExecutionTime, setCurrentExecutionTime] = useState(executionTime);

  // Sync states with query prop when it changes (initial load)
  useEffect(() => {
    setCurrentQuery(query);
    setEditedQuery(query);
  }, [query]);

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toaster.create({
        title: `${label} copied to clipboard`,
        type: 'success',
        duration: TOAST_DURATION.SHORT,
      });
    } catch (err) {
      toaster.create({
        title: 'Failed to copy',
        description: 'Could not copy to clipboard',
        type: 'error',
        duration: TOAST_DURATION.MEDIUM,
      });
    }
  };

  const executeQuery = async () => {
    setIsExecuting(true);
    try {
      const startTime = Date.now();
      
      // Determine the endpoint based on toolName
      let endpoint = '';
      if (toolName.toLowerCase().includes('logs')) {
        endpoint = QUERY_ENDPOINTS.LOGS;
      } else if (toolName.toLowerCase().includes('metrics')) {
        endpoint = QUERY_ENDPOINTS.METRICS;
      } else if (toolName.toLowerCase().includes('traces')) {
        endpoint = QUERY_ENDPOINTS.TRACES;
      } else {
        throw new Error('Unknown query type');
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: editedQuery }),
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.statusText}`);
      }

      const data = await response.json();
      const endTime = Date.now();
      
      setCurrentQuery(editedQuery);
      setCurrentResults(data.rows || []);
      setCurrentExecutionTime(data.execution_time_ms || (endTime - startTime));
      setIsEditing(false);
      
      toaster.create({
        title: 'Query executed successfully',
        description: `Returned ${data.rows?.length || 0} rows`,
        type: 'success',
        duration: TOAST_DURATION.MEDIUM,
      });
    } catch (err) {
      toaster.create({
        title: 'Query execution failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        type: 'error',
        duration: TOAST_DURATION.LONG,
      });
    } finally {
      setIsExecuting(false);
    }
  };
  
  return (
    <Box
      width="100%"
      height="100%"
      bg="var(--body-bg)"
      color="var(--text-primary)"
      overflowY="auto"
      overflowX="hidden"
      p={3}
      m={0}
      display="flex"
      flexDirection="column"
      gap={3}
    >
        {/* Header */}
        <MotionBox
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          flexShrink={0}
        >
          <Heading
            as="h2"
            fontSize={{ base: 'xl', md: '2xl', lg: '3xl' }}
            fontWeight="600"
            color="var(--text-primary)"
            mb={2}
          >
            {toolName}
          </Heading>
          <Text fontSize="sm" color="var(--text-secondary)">
            {currentExecutionTime ? `Execution time: ${currentExecutionTime}ms` : 'Viewing results from latest execution'}
          </Text>
        </MotionBox>

        {/* Query Display */}
        <MotionBox
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          flexShrink={0}
        >
          <VStack align="stretch" gap={2}>
            <HStack justify="space-between" align="center">
              <Text fontSize="sm" fontWeight="600" color="var(--text-secondary)">
                Query
              </Text>
              <HStack gap={2}>
                <IconButton
                  aria-label="Copy query"
                  size="sm"
                  variant="ghost"
                  colorPalette="purple"
                  onClick={() => copyToClipboard(isEditing ? editedQuery : currentQuery, 'Query')}
                >
                  <LuCopy />
                </IconButton>
                <IconButton
                  aria-label={isEditing ? "Cancel edit" : "Edit query"}
                  size="sm"
                  variant="ghost"
                  colorPalette="purple"
                  onClick={() => {
                    if (isEditing) {
                      // Canceling edit - reset to current query
                      setEditedQuery(currentQuery);
                      setIsEditing(false);
                    } else {
                      // Entering edit mode - sync editedQuery with current query
                      setEditedQuery(currentQuery);
                      setIsEditing(true);
                    }
                  }}
                >
                  {isEditing ? <LuX /> : <LuPencil />}
                </IconButton>
                {isEditing && (
                  <Button
                    size="sm"
                    colorPalette="purple"
                    onClick={executeQuery}
                    loading={isExecuting}
                    disabled={!editedQuery.trim()}
                  >
                    <LuPlay /> Run Query
                  </Button>
                )}
              </HStack>
            </HStack>
            {isEditing ? (
              <Textarea
                value={editedQuery}
                onChange={(e) => setEditedQuery(e.target.value)}
                fontFamily="monospace"
                fontSize="sm"
                minHeight="120px"
                background="var(--card-bg)"
                border="1px solid var(--border-color)"
                borderRadius="md"
                color="var(--text-primary)"
                _focus={{
                  borderColor: 'var(--accent-primary)',
                  boxShadow: '0 0 0 1px var(--accent-primary)',
                }}
              />
            ) : (
              <Box
                background="var(--card-bg)"
                border="1px solid var(--border-color)"
                borderRadius="md"
                p={4}
                fontFamily="monospace"
                fontSize="sm"
                whiteSpace="pre-wrap"
                overflowX="auto"
              >
                <Text color="var(--text-primary)">{currentQuery}</Text>
              </Box>
            )}
          </VStack>
        </MotionBox>

        {/* Results Table */}
        <MotionBox
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
          flexShrink={0}
        >
          <VStack align="stretch" gap={2}>
            <HStack justify="space-between" align="center" flexShrink={0}>
              <Text fontSize="sm" fontWeight="600" color="var(--text-secondary)">
                Results ({currentResults.length} rows)
              </Text>
              {currentResults.length > 0 && (
                <IconButton
                  aria-label="Copy results"
                  size="sm"
                  variant="ghost"
                  colorPalette="purple"
                  onClick={() => copyToClipboard(JSON.stringify(currentResults, null, 2), 'Results')}
                >
                  <LuCopy />
                </IconButton>
              )}
            </HStack>
            <Box
              background="var(--card-bg)"
              border="1px solid var(--border-color)"
              borderRadius="md"
              overflowX="auto"
              overflowY="visible"
            >
              {currentResults.length > 0 ? (
                <Table.Root size="sm" variant="outline">
                  <Table.Header>
                    <Table.Row background="var(--header-bg)">
                      {Object.keys(currentResults[0]).map((key) => (
                        <Table.ColumnHeader key={key} color="var(--text-primary)" fontWeight="600" whiteSpace="nowrap">
                          {key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}
                        </Table.ColumnHeader>
                      ))}
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {currentResults.map((row, index) => (
                      <Table.Row
                        key={index}
                        css={{
                          '&:hover': {
                            background: 'var(--card-hover-bg)',
                          },
                        }}
                      >
                        {Object.entries(row).map(([key, value], cellIndex) => (
                          <Table.Cell key={cellIndex} color="var(--text-primary)" whiteSpace="nowrap">
                            {typeof value === 'number' ? value.toLocaleString() : String(value)}
                          </Table.Cell>
                        ))}
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              ) : (
                <Box p={8} textAlign="center">
                  <Text color="var(--text-secondary)">No results</Text>
                </Box>
              )}
            </Box>
          </VStack>
        </MotionBox>
    </Box>
  );
};

// Memoize to prevent unnecessary re-renders when props haven't changed
export const QueryViewer = React.memo(QueryViewerComponent);
