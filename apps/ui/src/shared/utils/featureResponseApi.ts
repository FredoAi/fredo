import { API_BASE_URL } from '../constants/api';

/**
 * Generic feature response payload
 */
export interface GenericFeatureResponse {
  connectionId: string;
  featureId: string;
  payload: Record<string, any>;
  metadata?: Record<string, any>;
}

/**
 * Send a feature response to the backend
 * 
 * @param connectionId - MCP session/connection ID
 * @param featureId - Feature identifier (e.g., 'alerts', 'diagram', 'query-viewer')
 * @param payload - Response payload (flexible structure per feature)
 * @param metadata - Optional metadata (timestamps, correlation IDs, etc.)
 */
export async function sendFeatureResponse(
  connectionId: string,
  featureId: string,
  payload: Record<string, any>,
  metadata?: Record<string, any>
): Promise<void> {
  const url = `${API_BASE_URL}/api/v1/Fredo-ui/response`;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📤 [FEATURE RESPONSE] Sending to backend');
  console.log('   URL:', url);
  console.log('   🆔 Connection ID:', connectionId);
  console.log('   🏷️  Feature ID:', featureId);
  console.log('   📦 Payload:', payload);
  if (metadata) console.log('   📋 Metadata:', metadata);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        connectionId,
        featureId,
        payload,
        metadata: metadata || {},
      } as GenericFeatureResponse),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    console.log('   ✅ Response sent successfully:', result);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } catch (error) {
    console.error('   ❌ Failed to send response:', error);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    throw error;
  }
}
