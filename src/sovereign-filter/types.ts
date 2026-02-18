/**
 * Types for the Sovereign Filter – a dual-track message routing system
 * that prioritizes human relationships and sovereign attention control.
 */

// ---------------------------------------------------------------------------
// Sender classification
// ---------------------------------------------------------------------------

/** How the filter classifies an inbound sender. */
export type SenderClassification = "priority-human" | "known-human" | "system-noise";

/** Result of classifying an inbound message. */
export interface ClassificationResult {
  classification: SenderClassification;
  /** The matched contact entry when the sender is a known human. */
  contactEntry?: UrgencyTableEntry;
}

// ---------------------------------------------------------------------------
// Urgency Table (Azure Table Storage – source of truth)
// ---------------------------------------------------------------------------

/** A single row in the sovereign urgency table. */
export interface UrgencyTableEntry {
  /** Azure Table partition key – always "contacts". */
  partitionKey: string;
  /** Azure Table row key – normalized sender identifier. */
  rowKey: string;
  /** Human-readable display name for the contact. */
  displayName: string;
  /** Whether this contact is on the priority (immediate delivery) list. */
  isPriority: boolean;
  /** ISO-8601 timestamp of the last message received from this contact. */
  lastMessageAt?: string;
  /** ISO-8601 timestamp of the last message sent *to* this contact. */
  lastRepliedAt?: string;
  /** Optional notes about the relationship. */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Silent archive entity (Azure Table Storage)
// ---------------------------------------------------------------------------

/** A system-noise message archived silently. */
export interface ArchivedNoiseEntity {
  /** Azure Table partition key – date string YYYY-MM-DD for easy querying. */
  partitionKey: string;
  /** Azure Table row key – unique message id. */
  rowKey: string;
  /** The provider/channel the message arrived on. */
  provider: string;
  /** Sender identifier. */
  senderId: string;
  /** Sender display name if available. */
  senderName?: string;
  /** Original message body. */
  body: string;
  /** ISO-8601 timestamp. */
  receivedAt: string;
  /** Session key the message was routed to. */
  sessionKey?: string;
}

// ---------------------------------------------------------------------------
// Batched human message (in-memory queue)
// ---------------------------------------------------------------------------

/** A message held for batched delivery on the standard human track. */
export interface BatchedMessage {
  /** Sender identifier. */
  senderId: string;
  /** Sender display name. */
  senderName?: string;
  /** Raw message body – never summarized. */
  body: string;
  /** Provider/channel. */
  provider?: string;
  /** ISO-8601 timestamp when received. */
  receivedAt: string;
  /** Session key for reply routing. */
  sessionKey?: string;
  /** Originating channel for reply routing. */
  originatingChannel?: string;
  /** Destination for reply routing. */
  originatingTo?: string;
}

// ---------------------------------------------------------------------------
// Relationship maintenance suggestion
// ---------------------------------------------------------------------------

/** A nudge to restore affinity with a key contact. */
export interface RelationshipNudge {
  contactName: string;
  contactId: string;
  /** How many hours since last communication. */
  silentHours: number;
  /** Suggested acknowledgment item (from notes or generic). */
  suggestion: string;
}

// ---------------------------------------------------------------------------
// Sovereign filter configuration
// ---------------------------------------------------------------------------

/** Runtime configuration for the sovereign filter. */
export interface SovereignFilterConfig {
  /** Whether the sovereign filter is enabled. */
  enabled: boolean;
  /**
   * Cron expression for batch delivery of standard human messages.
   * Defaults to "0 9 * * *" (daily at 09:00).
   */
  batchSchedule: string;
  /**
   * Hours of silence before a relationship nudge is generated.
   * Defaults to 72 (3 days).
   */
  nudgeAfterSilentHours: number;
  /**
   * Azure Storage connection string override.
   * Falls back to AZURE_STORAGE_CONNECTION_STRING env var.
   */
  azureStorageConnectionString?: string;
}

export const DEFAULT_SOVEREIGN_FILTER_CONFIG: SovereignFilterConfig = {
  enabled: false,
  batchSchedule: "0 9 * * *",
  nudgeAfterSilentHours: 72,
};
