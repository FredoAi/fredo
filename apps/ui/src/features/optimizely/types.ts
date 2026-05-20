export type FlagEnvironment = 'production' | 'staging' | 'development';
export type FlagStatus = 'enabled' | 'disabled' | 'all';

export interface OptimizelyFlag {
  id: string;
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  environment: FlagEnvironment;
  rolloutPercentage: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GetFlagsResponse {
  success: boolean;
  flags: OptimizelyFlag[];
  total: number;
  isMockData: boolean;
}
