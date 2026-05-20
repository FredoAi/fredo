/**
 * SQL Query Validator
 * Ensures only safe SELECT queries are executed against the database
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Prohibited SQL keywords that indicate potentially dangerous operations
 */
const PROHIBITED_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE',
  'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'CALL', 'DECLARE', 'SET',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'PREPARE', 'DEALLOCATE'
];

/**
 * Validates that a SQL query is safe to execute
 * Only allows SELECT statements without dangerous constructs
 * 
 * @param query - The SQL query to validate
 * @returns ValidationResult with valid flag and optional error message
 */
export function validateQuery(query: string): ValidationResult {
  // 1. Check if query is empty or null
  if (!query || query.trim().length === 0) {
    return {
      valid: false,
      error: 'Query cannot be empty'
    };
  }

  const trimmedQuery = query.trim();

  // 2. Remove SQL comments to prevent comment-based injection
  // Remove single-line comments (-- and #)
  let cleanedQuery = trimmedQuery.replace(/--[^\n]*/g, '');
  cleanedQuery = cleanedQuery.replace(/#[^\n]*/g, '');
  
  // Remove multi-line comments (/* ... */)
  cleanedQuery = cleanedQuery.replace(/\/\*[\s\S]*?\*\//g, '');

  // 3. Check for multiple statements (semicolon-separated)
  // Allow semicolon at the end but not in the middle
  const statements = cleanedQuery.split(';').filter(s => s.trim().length > 0);
  if (statements.length > 1) {
    return {
      valid: false,
      error: 'Multiple SQL statements are not allowed. Only single SELECT queries are permitted.'
    };
  }

  // 4. Verify query starts with SELECT (case-insensitive)
  const upperQuery = cleanedQuery.toUpperCase();
  if (!upperQuery.startsWith('SELECT')) {
    return {
      valid: false,
      error: 'Only SELECT queries are allowed. Query must start with SELECT.'
    };
  }

  // 5. Check for prohibited keywords
  for (const keyword of PROHIBITED_KEYWORDS) {
    // Use word boundary to avoid false positives (e.g., "SELECTED" shouldn't match "SELECT")
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(cleanedQuery)) {
      return {
        valid: false,
        error: `Prohibited keyword detected: ${keyword}. Only SELECT queries are allowed.`
      };
    }
  }

  // 6. Check for potential SQL injection patterns
  // Look for suspicious patterns like dynamic SQL execution
  const suspiciousPatterns = [
    /EXEC\s*\(/i,
    /EXECUTE\s*\(/i,
    /xp_cmdshell/i,
    /sp_executesql/i,
    /UNION\s+ALL\s+SELECT/i  // UNION injection attempts
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(cleanedQuery)) {
      return {
        valid: false,
        error: 'Query contains suspicious patterns that may indicate SQL injection attempt.'
      };
    }
  }

  // 7. Check for excessive nesting that could indicate obfuscation
  const openParens = (cleanedQuery.match(/\(/g) || []).length;
  const closeParens = (cleanedQuery.match(/\)/g) || []).length;
  
  if (openParens !== closeParens) {
    return {
      valid: false,
      error: 'Query has unbalanced parentheses.'
    };
  }

  if (openParens > 20) {
    return {
      valid: false,
      error: 'Query has excessive nesting. Maximum 20 levels of parentheses allowed.'
    };
  }

  // Query passed all validation checks
  return {
    valid: true
  };
}

/**
 * Sanitizes a query by removing comments and extra whitespace
 * Should only be called AFTER validation passes
 * 
 * @param query - The validated SQL query
 * @returns Sanitized query string
 */
export function sanitizeQuery(query: string): string {
  let sanitized = query.trim();
  
  // Remove comments
  sanitized = sanitized.replace(/--[^\n]*/g, '');
  sanitized = sanitized.replace(/#[^\n]*/g, '');
  sanitized = sanitized.replace(/\/\*[\s\S]*?\*\//g, '');
  
  // Normalize whitespace
  sanitized = sanitized.replace(/\s+/g, ' ').trim();
  
  // Remove trailing semicolon if present
  if (sanitized.endsWith(';')) {
    sanitized = sanitized.slice(0, -1).trim();
  }
  
  return sanitized;
}
