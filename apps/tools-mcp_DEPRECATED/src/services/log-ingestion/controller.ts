import { LogIngestionRepository } from './repository.js';
import * as LogIngestionModel from './model.js';

export class LogIngestionController {
  private repository: LogIngestionRepository;

  constructor(repository: LogIngestionRepository) {
    this.repository = repository;
  }

  async processLogBatch(batch: LogIngestionModel.ExportLogsServiceRequest): Promise<void> {
    const logsToInsert: LogIngestionModel.ApplicationLog[] = [];

    for (const resourceLog of batch.resourceLogs) {
      for (const scopeLog of resourceLog.scopeLogs) {
        for (const record of scopeLog.logRecords) {
          const log = this.mapRecordToLog(record);
          if (log) {
            logsToInsert.push(log);
          }
        }
      }
    }

    if (logsToInsert.length > 0) {
      await this.repository.insertBatch(logsToInsert);
      console.log(`[LogIngestionController] Ingested ${logsToInsert.length} logs`);
    }
  }

  private mapRecordToLog(record: LogIngestionModel.OTLPLogRecord): LogIngestionModel.ApplicationLog | null {
    try {
      // Parse timestamp
      const timestamp = record.timeUnixNano 
        ? new Date(parseInt(record.timeUnixNano) / 1000000) 
        : new Date();

      // Extract attributes
      const attrs = new Map<string, string>();
      if (record.attributes) {
        for (const attr of record.attributes) {
          if (attr.value.stringValue) {
            attrs.set(attr.key, attr.value.stringValue);
          }
        }
      }

      return {
        timestamp,
        host: attrs.get('host') || 'unknown',
        thread_id: attrs.get('thread') || '',
        level: record.severityText || attrs.get('severity') || 'INFO',
        logger: attrs.get('logger') || '',
        message: record.body?.stringValue || '',
        file_path: attrs.get('log.file.path') || '',
        stack_trace: undefined
      };
    } catch (err) {
      console.warn('[LogIngestionController] Failed to map log record', err);
      return null;
    }
  }
}
