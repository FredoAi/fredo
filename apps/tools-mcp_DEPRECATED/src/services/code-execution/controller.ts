import type { CodeExecuteRequest, CodeExecuteResponse } from './model.js';
import type { CodeExecutionRepository } from './repository.js';

export class CodeExecutionController {
  constructor(private readonly repository: CodeExecutionRepository) {}

  async execute(req: CodeExecuteRequest): Promise<CodeExecuteResponse> {
    if (!req.code || typeof req.code !== 'string' || req.code.trim().length === 0) {
      throw new Error('code is required and must be a non-empty string');
    }
    return this.repository.execute(req);
  }

}
