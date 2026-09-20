export { FredoCompanion } from './FredoCompanion';
export { CompanionEntity, askActiveCompanion, askActiveCompanionWithAudio } from './CompanionEntity';
export type { CompanionEntityHandle, CompanionEntityProps } from './CompanionEntity';
export { SpeechBubble } from './SpeechBubble';
export type { CompanionState, CompanionPosition } from '../../contexts/CompanionContext';
export {
  QUEUED_WAITING_COPY,
  QUEUED_WAITING_TESTID,
  createCompanionSendQueue,
  queuedWaitingCopy,
  resolveSendOutcome,
} from './companionDispatch';
export type {
  CompanionSendOutcome,
  CompanionSendQueue,
  CompanionSendResult,
  QueuedCompanionSend,
} from './companionDispatch';
