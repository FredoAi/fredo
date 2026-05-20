import { useState, useEffect, useCallback } from 'react';
import { API_BASE_URL } from '../../../shared/constants/api';
import type { OptimizelyFlag, FlagEnvironment, FlagStatus, GetFlagsResponse } from '../types';

interface UseOptimizelyFlagsReturn {
  flags: OptimizelyFlag[];
  isLoading: boolean;
  error: string | null;
  isMockData: boolean;
  refetch: () => Promise<void>;
}

export function useOptimizelyFlags(
  environment?: FlagEnvironment,
  statusFilter?: FlagStatus,
): UseOptimizelyFlagsReturn {
  const [flags, setFlags] = useState<OptimizelyFlag[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMockData, setIsMockData] = useState(false);

  const fetchFlags = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (environment) params.set('environment', environment);
      if (statusFilter && statusFilter !== 'all') params.set('statusFilter', statusFilter);

      const url = `${API_BASE_URL}/api/v1/optimizely/flags${params.toString() ? `?${params}` : ''}`;
      const res = await fetch(url);

      if (!res.ok) {
        throw new Error(`Failed to fetch flags: ${res.status} ${res.statusText}`);
      }

      const data: GetFlagsResponse = await res.json();
      setFlags(data.flags);
      setIsMockData(data.isMockData);
    } catch (err: any) {
      setError(err.message ?? 'Unknown error while fetching flags');
    } finally {
      setIsLoading(false);
    }
  }, [environment, statusFilter]);

  useEffect(() => {
    fetchFlags();
  }, [fetchFlags]);

  return { flags, isLoading, error, isMockData, refetch: fetchFlags };
}
