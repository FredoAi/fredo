import React, { useState, useEffect, useRef } from 'react';
import { Box, VStack, HStack, Text, Button, Input, Textarea } from '@chakra-ui/react';
import { toaster } from '../../../../shared/components/ui/toaster';
import { LuMessageCircle, LuCircleCheck, LuRefreshCw } from 'react-icons/lu';
import { useCreateIssue } from '../../hooks/useCreateIssue';
import { buildReviewPrompt } from '../../utils/jiraCreatePromptBuilder';
import type { CreateIssueData, JiraIssueType, JiraPriority, JiraIssueCreated } from '../../types';

interface CreateIssueFormProps {
  initialData?: Partial<CreateIssueData>;
  onSuccess: (created: JiraIssueCreated) => void;
  onDataChange?: (data: Partial<CreateIssueData>) => void;
  updateCounter?: number;
}

const ISSUE_TYPES: JiraIssueType[] = ['Bug', 'Task', 'Story'];
const PRIORITIES: JiraPriority[] = ['Critical', 'High', 'Medium', 'Low'];

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <Text fontSize="xs" fontWeight="600" color="var(--text-secondary)" textTransform="uppercase" letterSpacing="0.5px">
      {children as React.ReactNode}{required && <Text as="span" color="var(--status-error)"> *</Text>}
    </Text>
  );
}

export const CreateIssueForm: React.FC<CreateIssueFormProps> = ({
  initialData = {},
  onSuccess,
  onDataChange,
  updateCounter = 0,
}) => {
  const { create, isLoading, error } = useCreateIssue();
  const [formData, setFormData] = useState<Partial<CreateIssueData>>(() => initialData);
  const [updatedFields, setUpdatedFields] = useState<Set<string>>(new Set());
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [labelInput, setLabelInput] = useState('');
  const prevUpdateCounterRef = useRef(updateCounter);

  // Sync when MCP event updates fields
  useEffect(() => {
    if (updateCounter > prevUpdateCounterRef.current && initialData) {
      prevUpdateCounterRef.current = updateCounter;

      const changedFields = new Set<string>();
      Object.keys(initialData).forEach((key) => {
        const k = key as keyof CreateIssueData;
        if (initialData[k] !== formData[k] && initialData[k]) {
          changedFields.add(key);
        }
      });

      setTimeout(() => {
        setFormData(prev => ({ ...prev, ...initialData }));

        if (changedFields.size > 0) {
          setUpdatedFields(changedFields);
          const fieldNames = Array.from(changedFields)
            .map(f => f.charAt(0).toUpperCase() + f.slice(1))
            .join(', ');
          toaster.create({
            title: 'Draft Updated',
            description: `Agent updated: ${fieldNames}`,
            type: 'info',
            duration: 4000,
          });
          setTimeout(() => setUpdatedFields(new Set()), 2000);
        }
      }, 0);
    }
  }, [updateCounter]);

  const setField = (field: keyof CreateIssueData, value: any) => {
    const next = { ...formData, [field]: value };
    setFormData(next);
    onDataChange?.(next);
    if (validationErrors[field]) {
      setValidationErrors(prev => {
        const n = { ...prev };
        delete n[field];
        return n;
      });
    }
  };

  const addLabel = () => {
    const trimmed = labelInput.trim();
    if (!trimmed) return;
    const labels = [...(formData.labels || [])];
    if (!labels.includes(trimmed)) labels.push(trimmed);
    setField('labels', labels);
    setLabelInput('');
  };

  const removeLabel = (label: string) => {
    setField('labels', (formData.labels || []).filter(l => l !== label));
  };

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    if (!formData.projectKey?.trim()) errors.projectKey = 'Project key is required';
    if (!formData.summary?.trim()) errors.summary = 'Summary is required';
    if (!formData.issueType) errors.issueType = 'Issue type is required';
    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleCreate = async () => {
    if (!validate()) {
      toaster.create({
        title: 'Validation Error',
        description: 'Please fill in all required fields',
        type: 'error',
        duration: 4000,
      });
      return;
    }

    try {
      const created = await create(formData as CreateIssueData);
      onSuccess(created);
    } catch {
      toaster.create({
        title: 'Creation Failed',
        description: error || 'Failed to create Jira issue',
        type: 'error',
        duration: 5000,
      });
    }
  };

  const handleAskAgent = () => {
    const prompt = buildReviewPrompt(formData);
    window.dispatchEvent(new CustomEvent('Fredo:inject-chat', { detail: { message: prompt } }));
    toaster.create({
      title: 'Sent to Agent',
      description: 'Draft sent for AI review',
      type: 'info',
      duration: 3000,
    });
  };

  const fieldClass = (field: string) => (updatedFields.has(field) ? 'field-updated' : '');

  return (
    <Box padding={4}>
      <style>{`
        @keyframes fieldUpdate {
          from { border-color: var(--status-success); box-shadow: 0 0 0 3px rgba(72,187,120,.2); }
          to   { border-color: var(--border-color); box-shadow: none; }
        }
        .field-updated input, .field-updated textarea, .field-updated select {
          animation: fieldUpdate 2s ease-out forwards;
        }
      `}</style>

      <VStack gap={4} align="stretch">
        {/* Project Key */}
        <Box className={fieldClass('projectKey')}>
          <FieldLabel required>Project Key</FieldLabel>
          <Input
            value={formData.projectKey || ''}
            onChange={e => setField('projectKey', e.target.value.toUpperCase())}
            placeholder="e.g. BUG, DEVOPS"
            size="sm"
            mt={1}
            background="var(--card-bg)"
            color="var(--text-primary)"
            borderColor={validationErrors.projectKey ? 'var(--status-error)' : 'var(--border-color)'}
            _hover={{ borderColor: 'var(--accent-primary)' }}
            _focus={{ borderColor: 'var(--accent-primary)', boxShadow: '0 0 0 1px var(--accent-primary)' }}
          />
          {validationErrors.projectKey && (
            <Text fontSize="xs" color="var(--status-error)" mt={1}>{validationErrors.projectKey}</Text>
          )}
        </Box>

        {/* Issue Type */}
        <Box className={fieldClass('issueType')}>
          <FieldLabel required>Issue Type</FieldLabel>
          <HStack gap={2} mt={1} wrap="wrap">
            {ISSUE_TYPES.map(type => (
              <Button
                key={type}
                size="xs"
                variant={formData.issueType === type ? 'solid' : 'outline'}
                colorPalette={formData.issueType === type ? 'purple' : 'gray'}
                onClick={() => setField('issueType', type)}
              >
                {type}
              </Button>
            ))}
          </HStack>
          {validationErrors.issueType && (
            <Text fontSize="xs" color="var(--status-error)" mt={1}>{validationErrors.issueType}</Text>
          )}
        </Box>

        {/* Summary */}
        <Box className={fieldClass('summary')}>
          <FieldLabel required>Summary</FieldLabel>
          <Input
            value={formData.summary || ''}
            onChange={e => setField('summary', e.target.value)}
            placeholder="Brief one-line description"
            size="sm"
            mt={1}
            background="var(--card-bg)"
            color="var(--text-primary)"
            borderColor={validationErrors.summary ? 'var(--status-error)' : 'var(--border-color)'}
            _hover={{ borderColor: 'var(--accent-primary)' }}
            _focus={{ borderColor: 'var(--accent-primary)', boxShadow: '0 0 0 1px var(--accent-primary)' }}
          />
          {validationErrors.summary && (
            <Text fontSize="xs" color="var(--status-error)" mt={1}>{validationErrors.summary}</Text>
          )}
        </Box>

        {/* Description */}
        <Box className={fieldClass('description')}>
          <FieldLabel>Description</FieldLabel>
          <Textarea
            value={formData.description || ''}
            onChange={e => setField('description', e.target.value)}
            placeholder="Detailed description (optional)"
            size="sm"
            mt={1}
            rows={4}
            background="var(--card-bg)"
            color="var(--text-primary)"
            borderColor="var(--border-color)"
            _hover={{ borderColor: 'var(--accent-primary)' }}
            _focus={{ borderColor: 'var(--accent-primary)', boxShadow: '0 0 0 1px var(--accent-primary)' }}
            resize="vertical"
          />
        </Box>

        {/* Priority */}
        <Box className={fieldClass('priority')}>
          <FieldLabel>Priority</FieldLabel>
          <HStack gap={2} mt={1} wrap="wrap">
            {PRIORITIES.map(p => {
              const color = p === 'Critical' ? 'red' : p === 'High' ? 'orange' : p === 'Medium' ? 'blue' : 'gray';
              return (
                <Button
                  key={p}
                  size="xs"
                  variant={formData.priority === p ? 'solid' : 'outline'}
                  colorPalette={formData.priority === p ? color : 'gray'}
                  onClick={() => setField('priority', p)}
                >
                  {p}
                </Button>
              );
            })}
          </HStack>
        </Box>

        {/* Labels */}
        <Box className={fieldClass('labels')}>
          <FieldLabel>Labels</FieldLabel>
          <HStack mt={1} gap={2}>
            <Input
              value={labelInput}
              onChange={e => setLabelInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addLabel()}
              placeholder="Type label and press Enter"
              size="sm"
              flex="1"
              background="var(--card-bg)"
              color="var(--text-primary)"
              borderColor="var(--border-color)"
              _hover={{ borderColor: 'var(--accent-primary)' }}
              _focus={{ borderColor: 'var(--accent-primary)', boxShadow: '0 0 0 1px var(--accent-primary)' }}
            />
            <Button size="sm" variant="outline" colorPalette="purple" onClick={addLabel}>+</Button>
          </HStack>
          {(formData.labels || []).length > 0 && (
            <HStack gap={2} mt={2} wrap="wrap">
              {(formData.labels || []).map(label => (
                <HStack
                  key={label}
                  gap={1}
                  paddingX={2}
                  paddingY={1}
                  borderRadius="full"
                  background="var(--card-bg)"
                  borderWidth="1px"
                  borderColor="var(--accent-primary)"
                >
                  <Text fontSize="xs" color="var(--text-primary)">{label}</Text>
                  <Button
                    size="xs"
                    variant="ghost"
                    height="auto"
                    minWidth="auto"
                    padding={0}
                    onClick={() => removeLabel(label)}
                    color="var(--text-secondary)"
                    _hover={{ color: 'var(--status-error)' }}
                  >
                    ×
                  </Button>
                </HStack>
              ))}
            </HStack>
          )}
        </Box>

        {/* Action Buttons */}
        <HStack gap={3} pt={2}>
          <Button
            flex="1"
            size="sm"
            variant="outline"
            colorPalette="blue"
            onClick={handleAskAgent}
            disabled={isLoading}
          >
            <HStack gap={2}>
              <LuMessageCircle size={14} />
              <span>Ask Agent</span>
            </HStack>
          </Button>
          <Button
            flex="1"
            size="sm"
            colorPalette="purple"
            onClick={handleCreate}
            loading={isLoading}
            loadingText="Creating..."
          >
            <HStack gap={2}>
              <LuCircleCheck size={14} />
              <span>Create Issue</span>
            </HStack>
          </Button>
        </HStack>
      </VStack>
    </Box>
  );
};
