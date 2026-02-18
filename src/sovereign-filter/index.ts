/**
 * Public API barrel for the Sovereign Filter module.
 */

export type {
  SenderClassification,
  ClassificationResult,
  UrgencyTableEntry,
  ArchivedNoiseEntity,
  BatchedMessage,
  RelationshipNudge,
  SovereignFilterConfig,
} from "./types.js";
export { DEFAULT_SOVEREIGN_FILTER_CONFIG } from "./types.js";

export {
  classifySender,
  MessageBatchQueue,
  generateRelationshipNudges,
  archiveSystemNoise,
  applySovereignFilter,
} from "./filter.js";
export type { SovereignFilterOutcome } from "./filter.js";

export {
  SovereignStorageClient,
  TABLE_URGENCY,
  TABLE_ARCHIVE,
  normalizeRowKey,
} from "./storage.js";
