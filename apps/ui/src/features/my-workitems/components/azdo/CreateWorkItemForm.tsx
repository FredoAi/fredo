import React, { useState, useEffect, useRef } from 'react';
import { Box, VStack, HStack, Text, Button, Input, Textarea, chakra } from '@chakra-ui/react';
import { toaster } from '../../../../shared/components/ui/toaster';
import { LuMessageCircle, LuCircleCheck, LuRefreshCw } from 'react-icons/lu';
import { useCreateWorkItem } from '../../hooks/useCreateWorkItem';
import { buildReviewRequestPrompt } from '../../utils/azdoCreatePromptBuilder';
import type { CreateWorkItemData } from '../../types';
import { getUserProfile } from '../../../../shared/utils/patStorage';

interface CreateWorkItemFormProps {
  initialData?: Partial<CreateWorkItemData>;
  onSuccess: (workItemId: number, workItemUrl: string) => void;
  onDataChange?: (data: Partial<CreateWorkItemData>) => void;
  updateCounter?: number;
}

export const CreateWorkItemForm: React.FC<CreateWorkItemFormProps> = ({
  initialData = {},
  onSuccess,
  onDataChange,
  updateCounter = 0
}) => {
  const { create, isLoading, error } = useCreateWorkItem();
  const [formData, setFormData] = useState<Partial<CreateWorkItemData>>(() => {
    // Always use currently logged-in PAT user for assignedTo
    const profile = getUserProfile();
    return {
      ...initialData,
      assignedTo: profile?.email || profile?.name // Always override with profile user
    };
  });
  const [updatedFields, setUpdatedFields] = useState<Set<string>>(new Set());
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const prevUpdateCounterRef = useRef(updateCounter);

  // Update form when initialData changes (from MCP events)
  useEffect(() => {
    if (updateCounter > prevUpdateCounterRef.current && initialData) {
      prevUpdateCounterRef.current = updateCounter;
      
      const changedFields = new Set<string>();
      const profile = getUserProfile();
      
      // Detect which fields changed (excluding assignedTo)
      Object.keys(initialData).forEach(key => {
        if (key === 'assignedTo') return; // Always ignore assignedTo from MCP
        const typedKey = key as keyof CreateWorkItemData;
        if (initialData[typedKey] !== formData[typedKey] && initialData[typedKey]) {
          changedFields.add(key);
        }
      });
      
      // Schedule state update to avoid flushSync warning
      setTimeout(() => {
        // Update form data, but always preserve current user's profile in assignedTo
        setFormData({
          ...initialData,
          assignedTo: profile?.email || profile?.name // Always use PAT user
        });
        
        // Highlight changed fields
        if (changedFields.size > 0) {
          setUpdatedFields(changedFields);
          
          // Format field names for display
          const formatFieldName = (field: string): string => {
            // Convert camelCase to Title Case
            return field
              .replace(/([A-Z])/g, ' $1')
              .replace(/^./, str => str.toUpperCase())
              .trim();
          };
          
          const fieldNames = Array.from(changedFields)
            .map(formatFieldName)
            .join(', ');
          
          // Show toast
          toaster.create({
            title: 'Draft Updated',
            description: `Agent updated: ${fieldNames}`,
            type: 'info',
            duration: 4000,
          });
          
          // Clear highlights after 2 seconds
          setTimeout(() => {
            setUpdatedFields(new Set());
          }, 2000);
        }
      }, 0);
    }
  }, [updateCounter]);

  const handleFieldChange = (field: keyof CreateWorkItemData, value: any) => {
    const newData = { ...formData, [field]: value };
    setFormData(newData);
    onDataChange?.(newData);
    
    // Clear validation error for this field
    if (validationErrors[field]) {
      const newErrors = { ...validationErrors };
      delete newErrors[field];
      setValidationErrors(newErrors);
    }
  };

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};
    
    if (!formData.title || formData.title.trim() === '') {
      errors.title = 'Title is required';
    }
    
    if (!formData.type) {
      errors.type = 'Work item type is required';
    }
    
    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleAskAgent = async () => {
    try {
      const prompt = buildReviewRequestPrompt(formData);
      // Extension-only: dispatch custom event for background to pick up.
      // In dev/VS Code this is a no-op (no background script to handle it).
      window.dispatchEvent(new CustomEvent('Fredo:inject-chat', { detail: { message: prompt } }));
      toaster.create({
        title: 'Sent to Agent',
        description: 'Draft sent for AI review and suggestions',
        type: 'info',
        duration: 3000,
      });
    } catch (err) {
      console.error('[CreateWorkItemForm] Failed to send prompt:', err);
      toaster.create({
        title: 'Failed to Send',
        description: 'Could not send draft to Agent. Please try again.',
        type: 'error',
        duration: 5000,
      });
    }
  };

  const handleCreate = async () => {
    if (!validateForm()) {
      toaster.create({
        title: 'Validation Error',
        description: 'Please fill in all required fields',
        type: 'error',
        duration: 5000,
      });
      return;
    }
    
    try {
      const { workItemId, workItemUrl } = await create(formData as CreateWorkItemData);
      
      // Success handled by parent feature - no toast needed
      onSuccess(workItemId, workItemUrl);
    } catch (err) {
      console.error('[CreateWorkItemForm] Creation error:', err);
      toaster.create({
        title: 'Creation Failed',
        description: error || 'Failed to create work item',
        type: 'error',
        duration: 5000,
      });
    }
  };

  const getFieldClassName = (field: string) => {
    return updatedFields.has(field) ? 'field-updated' : '';
  };

  return (
    <Box padding={4}>
      <style>
        {`
          @keyframes fieldUpdate {
            from {
              border-color: var(--status-success);
              box-shadow: 0 0 0 3px rgba(72, 187, 120, 0.2);
            }
            to {
              border-color: var(--border-color);
              box-shadow: none;
            }
          }
          
          .field-updated input,
          .field-updated textarea,
          .field-updated select {
            animation: fieldUpdate 2s ease-out;
          }
        `}
      </style>
      
      <VStack gap={4} align="stretch">
        <Text fontSize="lg" fontWeight="600" color="var(--text-primary)">
          Create Work Item
        </Text>
        
        {/* Title - Required */}
        <Box className={getFieldClassName('title')}>
          <Text fontSize="sm" fontWeight="medium" color="var(--text-primary)" marginBottom={2}>
            Title <Text as="span" color="var(--status-error)">*</Text>
          </Text>
          <Input
            value={formData.title || ''}
            onChange={(e) => handleFieldChange('title', e.target.value)}
            placeholder="Enter a clear, specific title"
            background="var(--card-bg)"
            borderColor="var(--border-color)"
            color="var(--text-primary)"
            _focus={{ borderColor: 'var(--accent-primary)' }}
          />
          {validationErrors.title && (
            <Text fontSize="xs" color="var(--status-error)" marginTop={1}>
              {validationErrors.title}
            </Text>
          )}
        </Box>
        
        {/* Type - Required */}
        <Box className={getFieldClassName('type')}>
          <Text fontSize="sm" fontWeight="medium" color="var(--text-primary)" marginBottom={2}>
            Type <Text as="span" color="var(--status-error)">*</Text>
          </Text>
          <chakra.select
            aria-label="Work item type"
            value={formData.type || ''}
            onChange={(e) => handleFieldChange('type', e.target.value)}
            width="100%"
            p={2}
            borderRadius="md"
            background="var(--card-bg)"
            border="1px solid"
            borderColor="var(--border-color)"
            color="var(--text-primary)"
            fontSize="sm"
            cursor="pointer"
            transition="all 0.2s"
            _hover={{ borderColor: 'var(--accent-primary)' }}
            _focus={{
              outline: 'none',
              borderColor: 'var(--accent-primary)',
              boxShadow: '0 0 0 1px var(--accent-primary)'
            }}
          >
            <option value="">Select type...</option>
            <option value="Bug">Bug</option>
            <option value="Task">Task</option>
            <option value="User Story">User Story</option>
            <option value="Feature">Feature</option>
            <option value="Epic">Epic</option>
          </chakra.select>
          {validationErrors.type && (
            <Text fontSize="xs" color="var(--status-error)" marginTop={1}>
              {validationErrors.type}
            </Text>
          )}
        </Box>
        
        {/* Description */}
        <Box className={getFieldClassName('description')}>
          <Text fontSize="sm" fontWeight="medium" color="var(--text-primary)" marginBottom={2}>
            Description
          </Text>
          <Textarea
            value={formData.description || ''}
            onChange={(e) => handleFieldChange('description', e.target.value)}
            placeholder="Detailed description of the work item"
            rows={4}
            background="var(--card-bg)"
            borderColor="var(--border-color)"
            color="var(--text-primary)"
            _focus={{ borderColor: 'var(--accent-primary)' }}
          />
        </Box>
        
        {/* Priority */}
        <Box className={getFieldClassName('priority')}>
          <Text fontSize="sm" fontWeight="medium" color="var(--text-primary)" marginBottom={2}>
            Priority
          </Text>
          <chakra.select
            aria-label="Priority"
            value={formData.priority || ''}
            onChange={(e) => handleFieldChange('priority', e.target.value ? parseInt(e.target.value) : undefined)}
            width="100%"
            p={2}
            borderRadius="md"
            background="var(--card-bg)"
            border="1px solid"
            borderColor="var(--border-color)"
            color="var(--text-primary)"
            fontSize="sm"
            cursor="pointer"
            transition="all 0.2s"
            _hover={{ borderColor: 'var(--accent-primary)' }}
            _focus={{
              outline: 'none',
              borderColor: 'var(--accent-primary)',
              boxShadow: '0 0 0 1px var(--accent-primary)'
            }}
          >
            <option value="">Select priority...</option>
            <option value="1">1 - Critical</option>
            <option value="2">2 - High</option>
            <option value="3">3 - Medium</option>
            <option value="4">4 - Low</option>
          </chakra.select>
        </Box>
        
        {/* Assigned To */}
        <Box className={getFieldClassName('assignedTo')}>
          <Text fontSize="sm" fontWeight="medium" color="var(--text-primary)" marginBottom={2}>
            Assigned To
          </Text>
          <Input
            value={formData.assignedTo || ''}
            onChange={(e) => handleFieldChange('assignedTo', e.target.value)}
            placeholder="Email or display name"
            background="var(--card-bg)"
            borderColor="var(--border-color)"
            color="var(--text-primary)"
            _focus={{ borderColor: 'var(--accent-primary)' }}
            disabled
            opacity={0.7}
            cursor="not-allowed"
          />
        </Box>
        
        {/* Tags */}
        <Box className={getFieldClassName('tags')}>
          <Text fontSize="sm" fontWeight="medium" color="var(--text-primary)" marginBottom={2}>
            Tags
          </Text>
          <Input
            value={formData.tags || ''}
            onChange={(e) => handleFieldChange('tags', e.target.value)}
            placeholder="Comma-separated tags"
            background="var(--card-bg)"
            borderColor="var(--border-color)"
            color="var(--text-primary)"
            _focus={{ borderColor: 'var(--accent-primary)' }}
          />
        </Box>
        
        {/* Acceptance Criteria */}
        <Box className={getFieldClassName('acceptanceCriteria')}>
          <Text fontSize="sm" fontWeight="medium" color="var(--text-primary)" marginBottom={2}>
            Acceptance Criteria
          </Text>
          <Textarea
            value={formData.acceptanceCriteria || ''}
            onChange={(e) => handleFieldChange('acceptanceCriteria', e.target.value)}
            placeholder="Clear criteria for completion"
            rows={3}
            background="var(--card-bg)"
            borderColor="var(--border-color)"
            color="var(--text-primary)"
            _focus={{ borderColor: 'var(--accent-primary)' }}
          />
        </Box>
        
        {/* Action Buttons */}
        <HStack gap={3} paddingTop={2}>
          <Button
            onClick={handleAskAgent}
            flex={1}
            variant="outline"
            borderColor="var(--border-color)"
            color="var(--text-primary)"
            _hover={{ bg: 'var(--card-hover-bg)', borderColor: 'var(--accent-primary)' }}
            disabled={isLoading}
          >
            <HStack gap={2}>
              <LuMessageCircle size={16} />
              <span>Ask for Help</span>
            </HStack>
          </Button>
          
          <Button
            onClick={handleCreate}
            flex={1}
            colorPalette="purple"
            variant="solid"
            disabled={isLoading}
          >
            <HStack gap={2}>
              {isLoading ? <LuRefreshCw size={16} /> : <LuCircleCheck size={16} />}
              <span>{isLoading ? 'Creating...' : 'Create Work Item'}</span>
            </HStack>
          </Button>
        </HStack>
      </VStack>
    </Box>
  );
};
