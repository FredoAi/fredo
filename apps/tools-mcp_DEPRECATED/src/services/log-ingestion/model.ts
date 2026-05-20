export interface OTLPLogRecord {
  timeUnixNano: string;
  severityNumber?: number;
  severityText?: string;
  body: {
    stringValue?: string;
  };
  attributes: {
    key: string;
    value: {
      stringValue?: string;
      intValue?: string;
      boolValue?: boolean;
    };
  }[];
  traceId?: string;
  spanId?: string;
}

export interface OTLPScopeLogs {
  scope: {
    name?: string;
    version?: string;
  };
  logRecords: OTLPLogRecord[];
}

export interface OTLPResourceLogs {
  resource: {
    attributes: {
      key: string;
      value: {
        stringValue?: string;
      };
    }[];
  };
  scopeLogs: OTLPScopeLogs[];
}

export interface ExportLogsServiceRequest {
  resourceLogs: OTLPResourceLogs[];
}

export interface ApplicationLog {
  timestamp: Date;
  host: string;
  thread_id: string;
  level: string;
  logger: string;
  message: string;
  stack_trace?: string;
  file_path: string;
}
