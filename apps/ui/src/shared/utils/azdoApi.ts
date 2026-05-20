/**
 * Azure DevOps API Service
 * Handles authentication and user profile operations
 */

export interface AzdoUserProfile {
  id: string;
  name: string;
  email: string;
}

export interface AzdoConnectionData {
  authenticatedUser: {
    id: string;
    providerDisplayName: string;
    properties?: {
      Account?: { $value: string };
    };
  };
}

export interface AzdoWorkItem {
  id: number;
  fields: {
    'System.Id': number;
    'System.Title': string;
    'System.WorkItemType': string;
    'System.State': string;
    'System.AssignedTo'?: {
      displayName: string;
      uniqueName: string;
    };
    'Microsoft.VSTS.Common.Priority'?: number;
    'System.CreatedDate'?: string;
    'System.ChangedDate'?: string;
    'System.AreaPath'?: string;
    'System.IterationPath'?: string;
    [key: string]: any; // Allow additional fields
  };
  url?: string;
}

export interface AzdoWorkItemDetails extends AzdoWorkItem {
  fields: AzdoWorkItem['fields'] & {
    'System.Description'?: string;
    'Microsoft.VSTS.Common.AcceptanceCriteria'?: string;
    'System.Tags'?: string;
  };
}

export interface AzdoWorkItemQueryResult {
  queryType: string;
  queryResultType: string;
  asOf: string;
  workItems: Array<{
    id: number;
    url: string;
  }>;
}

/**
 * Check if an error is a token expiration error (401/403)
 */
export function isTokenExpiredError(error: any): boolean {
  if (error instanceof Response) {
    return error.status === 401 || error.status === 403;
  }
  if (error?.response?.status) {
    return error.response.status === 401 || error.response.status === 403;
  }
  return false;
}

/**
 * Encode PAT to base64 for Basic authentication
 * Azure DevOps uses format: "Basic" + base64(":PAT")
 */
function encodePAT(pat: string): string {
  // Azure DevOps expects empty username with PAT: ":PAT"
  const credentials = `:${pat}`;
  return btoa(credentials);
}

/**
 * Validate a PAT by attempting to fetch connection data
 * 
 * @param org - Azure DevOps organization name
 * @param pat - Personal Access Token
 * @returns Promise<boolean> - True if PAT is valid
 * @throws Error if validation fails
 */
export async function validatePAT(org: string, pat: string): Promise<boolean> {
  const url = `https://dev.azure.com/${org}/_apis/connectionData?api-version=7.0-preview`;
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔐 [AZDO API] Validating PAT');
  console.log('   Organization:', org);
  console.log('   URL:', url);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${encodePAT(pat)}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('   ❌ PAT validation failed:', response.status, errorText);
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      if (response.status === 401 || response.status === 403) {
        throw new Error('Invalid or expired PAT. Please check your token and try again.');
      }
      
      throw new Error(`Failed to validate PAT: HTTP ${response.status}`);
    }

    console.log('   ✅ PAT is valid');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    return true;
  } catch (error) {
    console.error('   ❌ PAT validation error:', error);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    throw error;
  }
}

/**
 * Fetch user profile from Azure DevOps
 * 
 * @param org - Azure DevOps organization name
 * @param pat - Personal Access Token
 * @returns Promise<AzdoUserProfile> - User profile data
 * @throws Error if fetch fails
 */
export async function getUserProfile(org: string, pat: string): Promise<AzdoUserProfile> {
  const url = `https://dev.azure.com/${org}/_apis/connectionData?api-version=7.0-preview`;
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('👤 [AZDO API] Fetching user profile');
  console.log('   Organization:', org);
  console.log('   URL:', url);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${encodePAT(pat)}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('   ❌ Failed to fetch profile:', response.status, errorText);
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      if (response.status === 401 || response.status === 403) {
        throw new Error('Token expired or invalid. Please re-authenticate.');
      }
      
      throw new Error(`Failed to fetch user profile: HTTP ${response.status}`);
    }

    const data: AzdoConnectionData = await response.json();
    
    // Extract user information from connection data
    const profile: AzdoUserProfile = {
      id: data.authenticatedUser.id,
      name: data.authenticatedUser.providerDisplayName,
      email: data.authenticatedUser.properties?.Account?.$value || 'N/A',
    };

    console.log('   ✅ Profile fetched successfully');
    console.log('   📋 Name:', profile.name);
    console.log('   📧 Email:', profile.email);
    console.log('   🆔 ID:', profile.id);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    return profile;
  } catch (error) {
    console.error('   ❌ Profile fetch error:', error);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    throw error;
  }
}

/**
 * Fetch work items assigned to a user using WIQL query
 * 
 * @param org - Azure DevOps organization name
 * @param pat - Personal Access Token
 * @param project - Project name
 * @param userId - User ID (from profile)
 * @returns Promise<AzdoWorkItem[]> - Array of work items
 * @throws Error if fetch fails
 */
export async function getAssignedWorkItems(
  org: string,
  pat: string,
  project: string,
  userId: string
): Promise<AzdoWorkItem[]> {
  const wiqlUrl = `https://dev.azure.com/${org}/${project}/_apis/wit/wiql?api-version=7.0`;
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 [AZDO API] Fetching assigned work items');
  console.log('   Organization:', org);
  console.log('   Project:', project);
  console.log('   User ID:', userId);
  console.log('   URL:', wiqlUrl);

  try {
    // Step 1: Query for work item IDs (excluding closed/completed/removed items)
    const wiqlQuery = {
      query: `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.AssignedTo], [Microsoft.VSTS.Common.Priority], [System.ChangedDate] 
              FROM WorkItems 
              WHERE [System.AssignedTo] = @Me 
                AND [System.State] <> 'Closed'
                AND [System.State] <> 'Completed'
                AND [System.State] <> 'Removed'
              ORDER BY [System.ChangedDate] DESC`
    };

    const queryResponse = await fetch(wiqlUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${encodePAT(pat)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(wiqlQuery),
    });

    if (!queryResponse.ok) {
      const errorText = await queryResponse.text();
      console.error('   ❌ WIQL query failed:', queryResponse.status, errorText);
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      if (queryResponse.status === 401 || queryResponse.status === 403) {
        throw new Error('Token expired or invalid. Please re-authenticate.');
      }
      
      throw new Error(`Failed to query work items: HTTP ${queryResponse.status}`);
    }

    const queryResult: AzdoWorkItemQueryResult = await queryResponse.json();
    const workItemIds = queryResult.workItems.map(wi => wi.id);

    if (workItemIds.length === 0) {
      console.log('   ℹ️  No work items found');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      return [];
    }

    console.log(`   📦 Found ${workItemIds.length} work items`);

    // Step 2: Fetch work item details (batch)
    const batchUrl = `https://dev.azure.com/${org}/${project}/_apis/wit/workitems?ids=${workItemIds.join(',')}&api-version=7.0`;
    
    const batchResponse = await fetch(batchUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${encodePAT(pat)}`,
        'Content-Type': 'application/json',
      },
    });

    if (!batchResponse.ok) {
      const errorText = await batchResponse.text();
      console.error('   ❌ Failed to fetch work item details:', batchResponse.status, errorText);
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      throw new Error(`Failed to fetch work item details: HTTP ${batchResponse.status}`);
    }

    const batchResult: { count: number; value: AzdoWorkItem[] } = await batchResponse.json();

    console.log('   ✅ Work items fetched successfully');
    console.log(`   📊 Count: ${batchResult.count}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    return batchResult.value;
  } catch (error) {
    console.error('   ❌ Work items fetch error:', error);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    throw error;
  }
}

/**
 * Fetch detailed information for a specific work item
 * 
 * @param org - Azure DevOps organization name
 * @param pat - Personal Access Token
 * @param project - Project name
 * @param workItemId - Work item ID
 * @returns Promise<AzdoWorkItemDetails> - Detailed work item data
 * @throws Error if fetch fails
 */
export async function getWorkItemDetails(
  org: string,
  pat: string,
  project: string,
  workItemId: number
): Promise<AzdoWorkItemDetails> {
  const url = `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/${workItemId}?$expand=all&api-version=7.0`;
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔍 [AZDO API] Fetching work item details');
  console.log('   Organization:', org);
  console.log('   Project:', project);
  console.log('   Work Item ID:', workItemId);
  console.log('   URL:', url);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${encodePAT(pat)}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('   ❌ Failed to fetch work item details:', response.status, errorText);
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      if (response.status === 401 || response.status === 403) {
        throw new Error('Token expired or invalid. Please re-authenticate.');
      }
      
      if (response.status === 404) {
        throw new Error(`Work item #${workItemId} not found.`);
      }
      
      throw new Error(`Failed to fetch work item details: HTTP ${response.status}`);
    }

    const workItem: AzdoWorkItemDetails = await response.json();

    console.log('   ✅ Work item details fetched successfully');
    console.log('   📋 Title:', workItem.fields['System.Title']);
    console.log('   🏷️  Type:', workItem.fields['System.WorkItemType']);
    console.log('   📊 State:', workItem.fields['System.State']);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    return workItem;
  } catch (error) {
    console.error('   ❌ Work item details fetch error:', error);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    throw error;
  }
}

/**
 * Input data for creating a new work item
 */
export interface CreateWorkItemInput {
  title: string;
  type: 'Bug' | 'Task' | 'User Story' | 'Feature' | 'Epic';
  description?: string;
  priority?: 1 | 2 | 3 | 4;
  assignedTo?: string;
  tags?: string;
  areaPath?: string;
  iterationPath?: string;
  acceptanceCriteria?: string;
}

/**
 * Create a new work item in Azure DevOps
 * 
 * @param org - Azure DevOps organization name
 * @param pat - Personal Access Token
 * @param project - Project name
 * @param workItemData - Work item data
 * @returns Promise<AzdoWorkItemDetails> - Created work item with full details
 * @throws Error if creation fails
 */
export async function createWorkItem(
  org: string,
  pat: string,
  project: string,
  workItemData: CreateWorkItemInput
): Promise<AzdoWorkItemDetails> {
  const url = `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/$${workItemData.type}?api-version=7.0`;
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('➕ [AZDO API] Creating work item');
  console.log('   Organization:', org);
  console.log('   Project:', project);
  console.log('   Type:', workItemData.type);
  console.log('   Title:', workItemData.title);
  console.log('   URL:', url);

  try {
    // Build JSON Patch document for work item creation
    const patchDocument: Array<{ op: string; path: string; value: any }> = [];
    
    // Required fields
    patchDocument.push({
      op: 'add',
      path: '/fields/System.Title',
      value: workItemData.title
    });
    
    // Optional fields - add only if provided
    if (workItemData.description) {
      patchDocument.push({
        op: 'add',
        path: '/fields/System.Description',
        value: workItemData.description
      });
    }
    
    if (workItemData.priority) {
      patchDocument.push({
        op: 'add',
        path: '/fields/Microsoft.VSTS.Common.Priority',
        value: workItemData.priority
      });
    }
    
    if (workItemData.assignedTo) {
      patchDocument.push({
        op: 'add',
        path: '/fields/System.AssignedTo',
        value: workItemData.assignedTo
      });
    }
    
    if (workItemData.tags) {
      patchDocument.push({
        op: 'add',
        path: '/fields/System.Tags',
        value: workItemData.tags
      });
    }
    
    if (workItemData.areaPath) {
      patchDocument.push({
        op: 'add',
        path: '/fields/System.AreaPath',
        value: workItemData.areaPath
      });
    }
    
    if (workItemData.iterationPath) {
      patchDocument.push({
        op: 'add',
        path: '/fields/System.IterationPath',
        value: workItemData.iterationPath
      });
    }
    
    if (workItemData.acceptanceCriteria) {
      patchDocument.push({
        op: 'add',
        path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria',
        value: workItemData.acceptanceCriteria
      });
    }
    
    console.log('   📝 Fields to create:', patchDocument.length);
    
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Basic ${encodePAT(pat)}`,
        'Content-Type': 'application/json-patch+json',
      },
      body: JSON.stringify(patchDocument)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('   ❌ Failed to create work item:', response.status, errorText);
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      if (response.status === 401 || response.status === 403) {
        throw new Error('Token expired or invalid. Please re-authenticate.');
      }
      
      if (response.status === 400) {
        throw new Error(`Invalid work item data: ${errorText}`);
      }
      
      throw new Error(`Failed to create work item: HTTP ${response.status}`);
    }

    const createdWorkItem: AzdoWorkItemDetails = await response.json();
    const workItemId = createdWorkItem.id || createdWorkItem.fields['System.Id'];

    console.log('   ✅ Work item created successfully');
    console.log('   🆔 ID:', workItemId);
    console.log('   📋 Title:', createdWorkItem.fields['System.Title']);
    console.log('   🏷️  Type:', createdWorkItem.fields['System.WorkItemType']);
    console.log('   📊 State:', createdWorkItem.fields['System.State']);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    return createdWorkItem;
  } catch (error) {
    console.error('   ❌ Work item creation error:', error);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    throw error;
  }
}

