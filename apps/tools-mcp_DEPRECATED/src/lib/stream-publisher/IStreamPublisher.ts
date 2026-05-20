/**
 * IStreamPublisher — interface for stream event publishing
 * Implemented by StreamPublisher (Redis) and InMemoryStreamPublisher (in-process)
 */

import { StreamEvent, PublishOptions } from '../../core/types/StreamEvent.js';

export interface IStreamPublisher {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  publish(event: StreamEvent, options?: Partial<PublishOptions>): Promise<string>;
  get listenerCount(): number;
}
