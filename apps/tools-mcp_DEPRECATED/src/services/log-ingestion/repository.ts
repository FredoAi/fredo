import { db } from '../../core/db.js';
import { ApplicationLog } from './model.js';

export class LogIngestionRepository {
  async init(): Promise<void> {
    // Repository initialized with database singleton
  }

  async insertBatch(logs: ApplicationLog[]): Promise<void> {
    if (logs.length === 0) return;

    try {
      // Create values string for bulk insert
      // ($1, $2, ...), ($8, $9, ...)
      const values: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      for (const log of logs) {
        values.push(`($${paramIndex}, $${paramIndex+1}, $${paramIndex+2}, $${paramIndex+3}, $${paramIndex+4}, $${paramIndex+5}, $${paramIndex+6}, $${paramIndex+7})`);
        
        params.push(
          log.timestamp,
          log.host || null,
          log.thread_id || null,
          log.level || null,
          log.logger || null,
          log.message || null,
          log.stack_trace || null,
          log.file_path || null
        );
        
        paramIndex += 8;
      }

      const query = `
        INSERT INTO application_logs 
        (timestamp, host, thread_id, level, logger, message, stack_trace, file_path)
        VALUES ${values.join(', ')}
      `;

      await db.query(query, params);
      
    } catch (error) {
      console.error('[LogIngestionRepository] Error inserting logs:', error);
      throw error;
    }
  }
}
