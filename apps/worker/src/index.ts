export { processIngest, type IngestResult } from "./processors/ingest.js";
export { processFirstTouch, type FirstTouchResult } from "./processors/first-touch.js";
export { processMessagingOut, type RelayResult } from "./processors/relay.js";
export {
  processMessagingEvent,
  type InboundResult,
} from "./processors/messaging-events.js";
export {
  processConversation,
  type ConversationResult,
} from "./processors/conversation.js";
export { processBooking, releaseExpiredHolds, type BookingResult } from "./processors/booking.js";
export { processCrmSync, type CrmSyncResult } from "./processors/crm-sync.js";
export { processAssignment, type AssignResult } from "./processors/assignment.js";
export {
  processEscalation,
  acknowledgeLead,
  type EscalationResult,
} from "./processors/escalation.js";
export { processWorkflow, type WorkflowResult } from "./processors/workflow.js";
export {
  takeoverLead,
  resumeLead,
  retryFailedMessage,
} from "./processors/takeover.js";
export { makeDeps, type WorkerDeps } from "./deps.js";
