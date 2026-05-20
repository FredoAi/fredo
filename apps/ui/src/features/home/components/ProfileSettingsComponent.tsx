/**
 * Profile Settings Component
 * 
 * Manages Azure DevOps PAT input, validation, and user profile display.
 * Shows form when PAT is missing, displays profile once configured.
 */

import React, { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Input,
  Text,
  VStack,
  HStack,
  Spinner,
} from '@chakra-ui/react';
import { LuRefreshCw, LuPencil, LuSave, LuX } from 'react-icons/lu';
import { validatePAT, getUserProfile, isTokenExpiredError, type AzdoUserProfile } from '../../../shared/utils/azdoApi';
import {
  storePAT,
  storeOrg,
  storeProject,
  storeUserProfile,
  getPAT,
  getOrg,
  getProject,
  getUserProfile as getStoredProfile,
  clearAzdoData,
} from '../../../shared/utils/patStorage';
import { toaster } from '../../../shared/components/ui/toaster';
import { queueResponse } from '../../../shared/utils/responseQueue';

interface ProfileSettingsComponentProps {
  onClose?: () => void;
}

export const ProfileSettingsComponent: React.FC<ProfileSettingsComponentProps> = ({ onClose }) => {
  
  // Form state
  const [organization, setOrganization] = useState('');
  const [project, setProject] = useState('');
  const [pat, setPat] = useState('');
  
  // UI state
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [profile, setProfile] = useState<AzdoUserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load existing configuration on mount
  useEffect(() => {
    const storedOrg = getOrg();
    const storedProject = getProject();
    const storedPat = getPAT();
    const storedProfile = getStoredProfile();

    if (storedOrg && storedProject && storedPat && storedProfile) {
      setOrganization(storedOrg);
      setProject(storedProject);
      setPat(storedPat);
      setProfile(storedProfile);
      console.log('[ProfileSettings] Loaded existing configuration');
    } else {
      setIsEditing(true);
      console.log('[ProfileSettings] No configuration found, entering edit mode');
    }
  }, []);

  // Handle PAT save
  const handleSave = async () => {
    if (!organization.trim()) {
      toaster.create({
        title: 'Organization Required',
        description: 'Please enter your Azure DevOps organization name',
        type: 'error',
        duration: 5000,
      });
      return;
    }

    if (!project.trim()) {
      toaster.create({
        title: 'Project Required',
        description: 'Please enter your Azure DevOps project name',
        type: 'error',
        duration: 5000,
      });
      return;
    }

    if (!pat.trim()) {
      toaster.create({
        title: 'PAT Required',
        description: 'Please enter your Personal Access Token',
        type: 'error',
        duration: 5000,
      });
      return;
    }

    setIsLoading(true);
    setError(null);
    setLoadingMessage('Validating PAT...');

    try {
      // Step 1: Validate PAT
      console.log('[ProfileSettings] Validating PAT...');
      await validatePAT(organization, pat);
      
      // Step 2: Fetch user profile
      setLoadingMessage('Fetching user profile...');
      console.log('[ProfileSettings] Fetching user profile...');
      const userProfile = await getUserProfile(organization, pat);

      // Step 3: Store everything
      await storePAT(pat);
      await storeOrg(organization);
      await storeProject(project);
      await storeUserProfile(userProfile);
      setProfile(userProfile);
      setIsEditing(false);

      // Queue profile for next agent session
      const responseData = {
        organization,
        profile: userProfile,
        timestamp: new Date().toISOString(),
      };
      queueResponse('azdo-profile', responseData);
      console.log('[ProfileSettings] ✅ Response queued');

      // Success toast
      toaster.create({
        title: 'Profile Configured',
        description: `Welcome, ${userProfile.name}!`,
        type: 'success',
        duration: 5000,
      });

      console.log('[ProfileSettings] Configuration complete');
    } catch (err: any) {
      console.error('[ProfileSettings] Configuration failed:', err);
      setError(err.message || 'Failed to configure profile');
      
      // Check if token expired
      if (isTokenExpiredError(err)) {
        toaster.create({
          title: 'PAT Expired or Invalid',
          description: 'Please check your token and try again',
          type: 'error',
          duration: 7000,
        });
      } else {
        toaster.create({
          title: 'Configuration Failed',
          description: err.message || 'Failed to configure Azure DevOps profile',
          type: 'error',
          duration: 7000,
        });
      }
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  };

  // Handle profile refresh
  const handleRefresh = async () => {
    if (!organization || !pat) {
      toaster.create({
        title: 'Configuration Missing',
        description: 'Please configure your PAT first',
        type: 'warning',
        duration: 5000,
      });
      return;
    }

    setIsLoading(true);
    setLoadingMessage('Refreshing profile...');

    try {
      const userProfile = await getUserProfile(organization, pat);
      await storeUserProfile(userProfile);
      setProfile(userProfile);

      toaster.create({
        title: 'Profile Refreshed',
        description: 'User profile updated successfully',
        type: 'success',
        duration: 3000,
      });
    } catch (err: any) {
      console.error('[ProfileSettings] Refresh failed:', err);
      
      if (isTokenExpiredError(err)) {
        setError('PAT expired. Please re-authenticate.');
        setIsEditing(true);
        
        toaster.create({
          title: 'PAT Expired',
          description: 'Please enter a new Personal Access Token',
          type: 'error',
          duration: 7000,
        });
      } else {
        toaster.create({
          title: 'Refresh Failed',
          description: err.message || 'Failed to refresh profile',
          type: 'error',
          duration: 5000,
        });
      }
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  };

  // Handle edit mode
  const handleEdit = () => {
    setIsEditing(true);
  };

  // Handle cancel edit
  const handleCancelEdit = () => {
    // Restore stored values
    const storedOrg = getOrg();
    const storedProject = getProject();
    const storedPat = getPAT();
    
    if (storedOrg && storedProject && storedPat) {
      setOrganization(storedOrg);
      setProject(storedProject);
      setPat(storedPat);
      setIsEditing(false);
    }
  };

  // Render loading state
  if (isLoading) {
    return (
      <Box
        display="flex"
        alignItems="center"
        justifyContent="center"
        minHeight="300px"
        padding={8}
      >
        <VStack gap={4}>
          <Spinner size="xl" color="var(--accent-primary)" borderWidth="4px" />
          <Text fontSize="md" color="var(--text-primary)" fontWeight="medium">
            {loadingMessage}
          </Text>
        </VStack>
      </Box>
    );
  }

  // Render form mode
  if (isEditing || !profile) {
    return (
      <Box padding={6}>
        <VStack gap={5} align="stretch">
          <Text color="var(--text-secondary)" fontSize="sm">
            Enter your organization name, project name, and Personal Access Token to connect to Azure DevOps
          </Text>

          {error && (
            <Box
              bg="rgba(239, 68, 68, 0.1)"
              borderColor="var(--status-error)"
              borderWidth="1px"
              padding={3}
              borderRadius="md"
            >
              <Text fontSize="sm" color="var(--status-error)">{error}</Text>
            </Box>
          )}

          <VStack gap={4} align="stretch">
            <Box>
              <Text fontSize="sm" fontWeight="medium" color="var(--text-primary)" marginBottom={2}>
                Organization Name
              </Text>
              <Input
                value={organization}
                onChange={(e) => setOrganization(e.target.value)}
                placeholder="e.g., mycompany"
                size="lg"
                bg="var(--body-bg)"
                borderColor="var(--border-color)"
                color="var(--text-primary)"
                _placeholder={{ color: 'var(--text-secondary)' }}
                _hover={{ borderColor: 'var(--accent-primary)' }}
                _focus={{ borderColor: 'var(--accent-primary)', boxShadow: '0 0 0 1px var(--accent-primary)' }}
              />
            </Box>

            <Box>
              <Text fontSize="sm" fontWeight="medium" color="var(--text-primary)" marginBottom={2}>
                Project Name
              </Text>
              <Input
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder="e.g., MyProject"
                size="lg"
                bg="var(--body-bg)"
                borderColor="var(--border-color)"
                color="var(--text-primary)"
                _placeholder={{ color: 'var(--text-secondary)' }}
                _hover={{ borderColor: 'var(--accent-primary)' }}
                _focus={{ borderColor: 'var(--accent-primary)', boxShadow: '0 0 0 1px var(--accent-primary)' }}
              />
            </Box>

            <Box>
              <Text fontSize="sm" fontWeight="medium" color="var(--text-primary)" marginBottom={2}>
                Personal Access Token (PAT)
              </Text>
              <Input
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                type="password"
                placeholder="Enter your PAT"
                size="lg"
                bg="var(--body-bg)"
                borderColor="var(--border-color)"
                color="var(--text-primary)"
                _placeholder={{ color: 'var(--text-secondary)' }}
                _hover={{ borderColor: 'var(--accent-primary)' }}
                _focus={{ borderColor: 'var(--accent-primary)', boxShadow: '0 0 0 1px var(--accent-primary)' }}
              />
              <Text fontSize="xs" color="var(--text-secondary)" marginTop={1}>
                Your PAT will be stored securely in browser storage
              </Text>
            </Box>
          </VStack>

          <HStack gap={3} justify="flex-end">
            {profile && (
              <Button
                onClick={handleCancelEdit}
                variant="outline"
                bg="transparent"
                borderColor="var(--border-color)"
                color="var(--text-primary)"
                _hover={{ bg: 'var(--card-hover-bg)' }}
                size="md"
              >
                <HStack gap={2}>
                  <LuX size={16} />
                  <span>Cancel</span>
                </HStack>
              </Button>
            )}
            <Button
              onClick={handleSave}
              bg="var(--accent-primary)"
              color="white"
              _hover={{ opacity: 0.9 }}
              disabled={!organization.trim() || !project.trim() || !pat.trim()}
              _disabled={{ opacity: 0.5, cursor: 'not-allowed' }}
              size="md"
            >
              <HStack gap={2}>
                <LuSave size={16} />
                <span>Save Configuration</span>
              </HStack>
            </Button>
          </HStack>
        </VStack>
      </Box>
    );
  }

  // Render profile display mode
  return (
    <Box padding={6}>
      <VStack gap={5} align="stretch">
        <Box
          textAlign="center"
          paddingY={2}
          borderBottomWidth="1px"
          borderBottomColor="var(--border-color)"
        >
          <Text color="var(--text-secondary)" fontSize="sm">
            Connected to <Text as="span" color="var(--accent-primary)" fontWeight="600">{organization}</Text>
            {project && <> / <Text as="span" color="var(--accent-primary)" fontWeight="600">{project}</Text></>}
          </Text>
        </Box>

        <VStack gap={3} align="stretch">
          <Box
            bg="var(--body-bg)"
            padding={4}
            borderRadius="md"
            borderWidth="1px"
            borderColor="var(--border-color)"
            transition="all 0.2s"
            _hover={{ borderColor: 'var(--accent-primary)', bg: 'var(--card-hover-bg)' }}
          >
            <Text fontSize="xs" color="var(--text-secondary)" marginBottom={1} textTransform="uppercase" letterSpacing="wide">
              Name
            </Text>
            <Text fontSize="md" fontWeight="600" color="var(--text-primary)">
              {profile.name}
            </Text>
          </Box>

          <Box
            bg="var(--body-bg)"
            padding={4}
            borderRadius="md"
            borderWidth="1px"
            borderColor="var(--border-color)"
            transition="all 0.2s"
            _hover={{ borderColor: 'var(--accent-primary)', bg: 'var(--card-hover-bg)' }}
          >
            <Text fontSize="xs" color="var(--text-secondary)" marginBottom={1} textTransform="uppercase" letterSpacing="wide">
              Email
            </Text>
            <Text fontSize="md" fontWeight="600" color="var(--text-primary)">
              {profile.email}
            </Text>
          </Box>

          <Box
            bg="var(--body-bg)"
            padding={4}
            borderRadius="md"
            borderWidth="1px"
            borderColor="var(--border-color)"
            transition="all 0.2s"
            _hover={{ borderColor: 'var(--accent-primary)', bg: 'var(--card-hover-bg)' }}
          >
            <Text fontSize="xs" color="var(--text-secondary)" marginBottom={1} textTransform="uppercase" letterSpacing="wide">
              User ID
            </Text>
            <Text fontSize="sm" fontFamily="mono" color="var(--text-primary)">
              {profile.id}
            </Text>
          </Box>
        </VStack>

        <HStack gap={3} justify="flex-end">
          <Button
            onClick={handleRefresh}
            variant="outline"
            bg="transparent"
            borderColor="var(--accent-primary)"
            color="var(--accent-primary)"
            _hover={{ bg: 'var(--card-hover-bg)' }}
            size="md"
          >
            <HStack gap={2}>
              <LuRefreshCw size={16} />
              <span>Refresh</span>
            </HStack>
          </Button>
          <Button
            onClick={handleEdit}
            bg="var(--accent-primary)"
            color="white"
            _hover={{ opacity: 0.9 }}
            size="md"
          >
            <HStack gap={2}>
              <LuPencil size={16} />
              <span>Edit PAT</span>
            </HStack>
          </Button>
        </HStack>
      </VStack>
    </Box>
  );
};
