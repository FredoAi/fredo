import React, { useState, useMemo } from 'react';
import {
  Box,
  Badge,
  Button,
  Dialog,
  Flex,
  HStack,
  Input,
  Spinner,
  Switch,
  Text,
  VStack,
} from '@chakra-ui/react';
import {
  LuTriangleAlert,
  LuRefreshCw,
  LuChevronRight,
  LuChevronDown,
  LuSearch,
} from 'react-icons/lu';
import { useOptimizelyFlags } from '../hooks/useOptimizelyFlags';
import type { OptimizelyFlag, FlagEnvironment } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface FlagGroup {
  key: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  environments: OptimizelyFlag[];
}

function groupFlags(flags: OptimizelyFlag[]): FlagGroup[] {
  const map = new Map<string, FlagGroup>();
  for (const flag of flags) {
    if (!map.has(flag.key)) {
      map.set(flag.key, {
        key: flag.key,
        name: flag.name,
        description: flag.description,
        createdAt: flag.createdAt,
        updatedAt: flag.updatedAt,
        environments: [],
      });
    }
    map.get(flag.key)!.environments.push(flag);
  }
  return Array.from(map.values());
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

// Display the environment key exactly as returned by the API (e.g. "Internal", "DevInt", "QA", etc.)
const getEnvLabel = (env: string): string => {
  const known: Record<string, string> = {
    production: 'Production',
    staging: 'Staging',
    development: 'Development',
  };
  return known[env] ?? env;
};

// ── Status badge ──────────────────────────────────────────────────────────────

const StatusBadge: React.FC<{ enabled: boolean }> = ({ enabled }) => (
  <Badge
    px="8px"
    py="2px"
    borderRadius="full"
    fontSize="xs"
    fontWeight="500"
    background={enabled ? 'rgba(34, 197, 94, 0.12)' : 'rgba(148, 163, 184, 0.08)'}
    color={enabled ? '#4ade80' : 'var(--text-muted)'}
    border="1px solid"
    borderColor={enabled ? 'rgba(74, 222, 128, 0.28)' : 'rgba(148, 163, 184, 0.18)'}
    display="inline-flex"
    alignItems="center"
    gap="5px"
  >
    <Box
      as="span"
      width="6px"
      height="6px"
      borderRadius="full"
      background={enabled ? '#4ade80' : 'rgba(148, 163, 184, 0.5)'}
      flexShrink={0}
    />
    {enabled ? 'Running' : 'Draft'}
  </Badge>
);

// ── Confirmation dialog ───────────────────────────────────────────────────────

interface ConfirmToggleDialogProps {
  flag: OptimizelyFlag | null;
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

const ConfirmToggleDialog: React.FC<ConfirmToggleDialogProps> = ({
  flag, open, onClose, onConfirm,
}) => {
  if (!flag) return null;
  const action = flag.enabled ? 'disable' : 'enable';
  const actionColor = flag.enabled ? 'var(--status-error)' : 'var(--status-success)';
  const envColor =
    flag.environment === 'production'
      ? 'var(--status-error)'
      : flag.environment === 'staging'
      ? 'var(--status-warning)'
      : 'var(--status-info)';

  return (
    <Dialog.Root open={open} onOpenChange={(details) => !details.open && onClose()}>
      <Dialog.Backdrop bg="rgba(0,0,0,0.55)" backdropFilter="blur(4px)" />
      <Dialog.Positioner>
        <Dialog.Content
          background="var(--card-bg)"
          borderColor="var(--border-color)"
          borderWidth="1px"
          borderRadius="lg"
        >
          <Dialog.Header>
            <Dialog.Title color="var(--text-primary)">
              <HStack gap={2}>
                <Box color="var(--status-warning)" fontSize="lg">
                  <LuTriangleAlert />
                </Box>
                <Text>Confirm flag change</Text>
              </HStack>
            </Dialog.Title>
          </Dialog.Header>
          <Dialog.Body>
            <VStack align="start" gap={3}>
              <Text color="var(--text-primary)">
                Are you 100% sure you want to{' '}
                <Text as="span" fontWeight="bold" color={actionColor}>
                  {action}
                </Text>{' '}
                the following feature flag?
              </Text>
              <Box
                background="var(--body-bg)"
                border="1px solid var(--border-color)"
                borderRadius="md"
                p={3}
                width="100%"
              >
                <Text fontWeight="semibold" color="var(--text-primary)" fontSize="sm">
                  {flag.name}
                </Text>
                <Text color="var(--text-secondary)" fontSize="xs" mt={1}>
                  <Text as="span" fontFamily="mono">{flag.key}</Text>
                  {' · '}
                  <Text as="span" style={{ color: envColor }}>
                    {getEnvLabel(flag.environment)}
                  </Text>
                </Text>
                {flag.description && (
                  <Text color="var(--text-secondary)" fontSize="xs" mt={2}>
                    {flag.description}
                  </Text>
                )}
                {flag.environment === 'production' && (
                  <HStack mt={2} gap={1} background="rgba(239,68,68,0.1)" borderRadius="sm" p={2}>
                    <Box color="var(--status-error)" flexShrink={0}>
                      <LuTriangleAlert size={12} />
                    </Box>
                    <Text color="var(--status-error)" fontSize="xs">
                      This flag is in <strong>production</strong>. Changes affect live users.
                    </Text>
                  </HStack>
                )}
              </Box>
            </VStack>
          </Dialog.Body>
          <Dialog.Footer gap={2}>
            <Button
              variant="outline"
              size="sm"
              borderColor="var(--border-color)"
              color="var(--text-secondary)"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              background={actionColor}
              color="white"
              onClick={onConfirm}
              _hover={{ opacity: 0.85 }}
            >
              Yes, {action} it
            </Button>
          </Dialog.Footer>
          <Dialog.CloseTrigger
            position="absolute"
            top="8px"
            right="8px"
            color="var(--text-secondary)"
            onClick={onClose}
          />
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
};

// ── Table columns config ──────────────────────────────────────────────────────

const COL = {
  chevron: '28px',
  name: '1',      // flex
  key: '190px',
  status: '96px',
  modified: '110px',
  created: '110px',
  toggle: '52px',
};

// ── Table header row ──────────────────────────────────────────────────────────

const TableHeader: React.FC = () => (
  <Flex
    align="center"
    px={4}
    py={2}
    borderBottom="1px solid var(--border-color)"
    background="rgba(0,0,0,0.18)"
    flexShrink={0}
    gap={3}
  >
    <Box width={COL.chevron} flexShrink={0} />
    <Text flex={COL.name} minW="0" fontSize="11px" fontWeight="600" color="var(--text-muted)" textTransform="uppercase" letterSpacing="wider">
      Name
    </Text>
    <Text width={COL.key} flexShrink={0} fontSize="11px" fontWeight="600" color="var(--text-muted)" textTransform="uppercase" letterSpacing="wider">
      Key
    </Text>
    <Text width={COL.status} flexShrink={0} fontSize="11px" fontWeight="600" color="var(--text-muted)" textTransform="uppercase" letterSpacing="wider">
      Status
    </Text>
    <Text width={COL.modified} flexShrink={0} fontSize="11px" fontWeight="600" color="var(--text-muted)" textTransform="uppercase" letterSpacing="wider">
      Modified
    </Text>
    <Text width={COL.created} flexShrink={0} fontSize="11px" fontWeight="600" color="var(--text-muted)" textTransform="uppercase" letterSpacing="wider">
      Created ↓
    </Text>
    <Box width={COL.toggle} flexShrink={0} />
  </Flex>
);

// ── Flag row (parent + expandable env sub-rows) ───────────────────────────────

interface FlagRowProps {
  group: FlagGroup;
  isExpanded: boolean;
  onToggle: () => void;
  onToggleRequest: (flag: OptimizelyFlag) => void;
}

const FlagRow: React.FC<FlagRowProps> = ({ group, isExpanded, onToggle, onToggleRequest }) => (
  <>
    {/* Parent row */}
    <Flex
      align="center"
      px={4}
      py={3}
      gap={3}
      borderBottom="1px solid var(--border-color)"
      cursor="pointer"
      onClick={onToggle}
      transition="background 0.15s"
      _hover={{ background: 'rgba(147, 51, 234, 0.06)' }}
      role="button"
    >
      <Box width={COL.chevron} flexShrink={0} color="var(--text-muted)" fontSize="sm" display="flex" alignItems="center">
        {isExpanded ? <LuChevronDown /> : <LuChevronRight />}
      </Box>

      {/* Name + description */}
      <Box flex={COL.name} minW="0">
        <Text
          fontSize="sm"
          fontWeight="500"
          color="var(--accent-primary)"
          lineClamp={1}
          cursor="pointer"
        >
          {group.name}
        </Text>
        {group.description && (
          <Text fontSize="xs" color="var(--text-muted)" lineClamp={1} mt="2px">
            {group.description}
          </Text>
        )}
      </Box>

      {/* Key */}
      <Box width={COL.key} flexShrink={0}>
        <Text fontSize="xs" fontFamily="mono" color="var(--text-secondary)" lineClamp={1}>
          {group.key}
        </Text>
      </Box>

      {/* Status — blank on parent */}
      <Box width={COL.status} flexShrink={0} />

      {/* Modified */}
      <Text width={COL.modified} flexShrink={0} fontSize="xs" color="var(--text-secondary)">
        {formatDate(group.updatedAt)}
      </Text>

      {/* Created */}
      <Text width={COL.created} flexShrink={0} fontSize="xs" color="var(--text-secondary)">
        {formatDate(group.createdAt)}
      </Text>

      {/* Toggle placeholder */}
      <Box width={COL.toggle} flexShrink={0} />
    </Flex>

    {/* Environment sub-rows */}
    {isExpanded &&
      group.environments.map((flag) => (
        <Flex
          key={flag.id}
          align="center"
          px={4}
          py="10px"
          gap={3}
          borderBottom="1px solid rgba(255,255,255,0.04)"
          background="rgba(0,0,0,0.14)"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Indent line */}
          <Box width={COL.chevron} flexShrink={0} display="flex" alignItems="center" justifyContent="center">
            <Box width="1px" height="100%" background="var(--border-color)" />
          </Box>

          {/* Environment name */}
          <Box flex={COL.name} minW="0" pl={3}>
            <Text fontSize="sm" color="var(--text-primary)">
              {getEnvLabel(flag.environment)}
            </Text>
          </Box>

          {/* Key — blank in sub-row */}
          <Box width={COL.key} flexShrink={0} />

          {/* Status badge */}
          <Box width={COL.status} flexShrink={0}>
            <StatusBadge enabled={flag.enabled} />
          </Box>

          {/* Date columns — blank in sub-row */}
          <Box width={COL.modified} flexShrink={0} />
          <Box width={COL.created} flexShrink={0} />

          {/* Toggle */}
          <Box width={COL.toggle} flexShrink={0} display="flex" justifyContent="flex-end">
            <Switch.Root
              checked={flag.enabled}
              onCheckedChange={() => onToggleRequest(flag)}
              colorPalette="green"
              size="sm"
              onClick={(e) => e.stopPropagation()}
            >
              <Switch.HiddenInput />
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Root>
          </Box>
        </Flex>
      ))}
  </>
);

// ── Main component ────────────────────────────────────────────────────────────

export const OptimizelyFlagsPanel: React.FC = () => {
  const [search, setSearch] = useState('');
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [pendingFlag, setPendingFlag] = useState<OptimizelyFlag | null>(null);

  const { flags, isLoading, error, isMockData, refetch } = useOptimizelyFlags();

  const groups = useMemo(() => {
    const all = groupFlags(flags);
    if (!search.trim()) return all;
    const q = search.toLowerCase();
    return all.filter(
      (g) => g.name.toLowerCase().includes(q) || g.key.toLowerCase().includes(q),
    );
  }, [flags, search]);

  const allKeys = useMemo(() => groups.map((g) => g.key), [groups]);

  const toggleRow = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const expandAll = () => setExpandedKeys(new Set(allKeys));
  const collapseAll = () => setExpandedKeys(new Set());

  return (
    <Box height="100%" display="flex" flexDirection="column" overflow="hidden">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <Flex
        px={4}
        py={3}
        justify="space-between"
        align="center"
        borderBottom="1px solid var(--border-color)"
        flexShrink={0}
      >
        <VStack align="start" gap={0}>
          <Text fontWeight="600" color="var(--text-primary)" fontSize="md">
            Feature Flags
          </Text>
          {isMockData && (
            <Text color="var(--status-warning)" fontSize="xs">
              Showing mock data — configure Optimizely credentials
            </Text>
          )}
        </VStack>
        <Button
          size="xs"
          variant="ghost"
          color="var(--text-secondary)"
          onClick={refetch}
          disabled={isLoading}
          _hover={{ color: 'var(--text-primary)', background: 'var(--card-hover-bg)' }}
        >
          <LuRefreshCw size={13} />
        </Button>
      </Flex>

      {/* ── Sub-header: description + expand controls ───────────────────────── */}
      <Flex
        px={4}
        py="10px"
        justify="space-between"
        align="center"
        borderBottom="1px solid var(--border-color)"
        flexShrink={0}
        background="rgba(0,0,0,0.08)"
      >
        <Text fontSize="xs" color="var(--text-muted)" flex={1} mr={4}>
          Flags are decision points in your code and rules are used to run experiments and rollouts.
        </Text>
        <HStack gap={1} flexShrink={0}>
          <Button
            variant="ghost"
            size="xs"
            color="var(--accent-primary)"
            onClick={expandAll}
            px={2}
            height="22px"
            fontSize="xs"
            _hover={{ background: 'rgba(147, 51, 234, 0.08)' }}
          >
            Expand All
          </Button>
          <Text color="var(--border-color)" fontSize="sm" userSelect="none">|</Text>
          <Button
            variant="ghost"
            size="xs"
            color="var(--accent-primary)"
            onClick={collapseAll}
            px={2}
            height="22px"
            fontSize="xs"
            _hover={{ background: 'rgba(147, 51, 234, 0.08)' }}
          >
            Collapse All
          </Button>
        </HStack>
      </Flex>

      {/* ── Search bar ──────────────────────────────────────────────────────── */}
      <Box px={4} py={3} borderBottom="1px solid var(--border-color)" flexShrink={0}>
        <Flex
          align="center"
          gap={2}
          background="var(--card-bg)"
          border="1px solid var(--border-color)"
          borderRadius="md"
          px={3}
          py="7px"
          transition="border-color 0.15s"
          _focusWithin={{ borderColor: 'var(--accent-primary)' }}
        >
          <Box color="var(--text-muted)" flexShrink={0} fontSize="sm" display="flex" alignItems="center">
            <LuSearch />
          </Box>
          <Input
            placeholder="Search by name or key"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            border="none"
            boxShadow="none"
            background="transparent"
            color="var(--text-primary)"
            fontSize="sm"
            p={0}
            height="auto"
            _placeholder={{ color: 'var(--text-muted)' }}
            _focus={{ outline: 'none', boxShadow: 'none', borderColor: 'transparent' }}
          />
        </Flex>
      </Box>

      {/* ── Table header ────────────────────────────────────────────────────── */}
      <TableHeader />

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <Box flex={1} overflowY="auto">
        {isLoading && flags.length === 0 ? (
          <Flex justify="center" align="center" height="100%">
            <VStack gap={3}>
              <Spinner color="var(--accent-primary)" size="md" />
              <Text color="var(--text-secondary)" fontSize="sm">Loading flags…</Text>
            </VStack>
          </Flex>
        ) : error ? (
          <Flex justify="center" align="center" height="100%">
            <VStack gap={2} textAlign="center">
              <Box color="var(--status-error)" fontSize="2xl"><LuTriangleAlert /></Box>
              <Text color="var(--status-error)" fontSize="sm" fontWeight="medium">
                Failed to load flags
              </Text>
              <Text color="var(--text-secondary)" fontSize="xs">{error}</Text>
              <Button
                size="xs"
                variant="outline"
                borderColor="var(--border-color)"
                color="var(--text-secondary)"
                onClick={refetch}
                mt={1}
              >
                Retry
              </Button>
            </VStack>
          </Flex>
        ) : groups.length === 0 ? (
          <Flex justify="center" align="center" height="100%">
            <Text color="var(--text-secondary)" fontSize="sm">
              No flags {search ? 'match your search' : 'found'}.
            </Text>
          </Flex>
        ) : (
          groups.map((group) => (
            <FlagRow
              key={group.key}
              group={group}
              isExpanded={expandedKeys.has(group.key)}
              onToggle={() => toggleRow(group.key)}
              onToggleRequest={setPendingFlag}
            />
          ))
        )}
      </Box>

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      {flags.length > 0 && (
        <Flex
          px={4}
          py="8px"
          borderTop="1px solid var(--border-color)"
          justify="space-between"
          align="center"
          flexShrink={0}
          background="rgba(0,0,0,0.1)"
        >
          <Text color="var(--text-muted)" fontSize="xs">
            {groups.length} flag{groups.length !== 1 ? 's' : ''}
            {search && ` matching "${search}"`}
          </Text>
          <Text color="var(--text-muted)" fontSize="xs">
            {flags.filter((f) => f.enabled).length} running ·{' '}
            {flags.filter((f) => !f.enabled).length} draft
          </Text>
        </Flex>
      )}

      {/* ── Confirmation dialog ──────────────────────────────────────────────── */}
      <ConfirmToggleDialog
        flag={pendingFlag}
        open={!!pendingFlag}
        onClose={() => setPendingFlag(null)}
        onConfirm={() => setPendingFlag(null)}
      />
    </Box>
  );
};


