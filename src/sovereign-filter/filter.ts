/**
 * Core Sovereign Filter logic.
 *
 * Classifies inbound messages into three tracks:
 *   1. **Priority Human** → deliver raw, immediately.
 *   2. **Known Human**    → hold raw, deliver in scheduled batch.
 *   3. **System Noise**   → archive silently to Azure Table Storage.
 *
 * Key design principles:
 *   - Human messages are NEVER summarized by AI – raw text only.
 *   - The urgency table in Azure Table Storage is the sole authority
 *     for who is "priority" vs "known human."
 *   - System/bot noise is silently archived, never pushed.
 */

import type { MsgContext } from "../auto-reply/templating.js";
import type {
  ArchivedNoiseEntity,
  BatchedMessage,
  ClassificationResult,
  RelationshipNudge,
  SovereignFilterConfig,
  UrgencyTableEntry,
} from "./types.js";
import { SovereignStorageClient } from "./storage.js";
import { DEFAULT_SOVEREIGN_FILTER_CONFIG } from "./types.js";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify an inbound message sender.
 *
 * Resolution order:
 *   1. Look up sender in the urgency table → priority-human or known-human.
 *   2. If not found, treat as system-noise.
 */
export async function classifySender(
  ctx: MsgContext,
  storage: SovereignStorageClient,
): Promise<ClassificationResult> {
  const senderId = ctx.SenderId ?? ctx.From ?? "";

  if (!senderId) {
    return { classification: "system-noise" };
  }

  const contact = await storage.getContact(senderId);

  if (contact) {
    return {
      classification: contact.isPriority ? "priority-human" : "known-human",
      contactEntry: contact,
    };
  }

  // Not in urgency table → system noise
  return { classification: "system-noise" };
}

// ---------------------------------------------------------------------------
// Message batching (in-memory queue)
// ---------------------------------------------------------------------------

/**
 * In-memory batch queue for the standard human track.
 * Messages are held here until the scheduled delivery time.
 */
export class MessageBatchQueue {
  private queue: BatchedMessage[] = [];

  /** Add a message to the batch queue. */
  enqueue(msg: BatchedMessage): void {
    this.queue.push(msg);
  }

  /** Drain and return all queued messages, clearing the queue. */
  drain(): BatchedMessage[] {
    const batch = [...this.queue];
    this.queue = [];
    return batch;
  }

  /** Peek at queued messages without draining. */
  peek(): readonly BatchedMessage[] {
    return this.queue;
  }

  /** Number of queued messages. */
  get size(): number {
    return this.queue.length;
  }
}

// ---------------------------------------------------------------------------
// Relationship maintenance
// ---------------------------------------------------------------------------

/**
 * Generate nudges for contacts that have gone silent.
 *
 * If a priority/known contact hasn't been communicated with in
 * `config.nudgeAfterSilentHours`, produce a suggestion to reconnect.
 */
export async function generateRelationshipNudges(
  storage: SovereignStorageClient,
  config: SovereignFilterConfig = DEFAULT_SOVEREIGN_FILTER_CONFIG,
): Promise<RelationshipNudge[]> {
  const silent = await storage.findSilentContacts(config.nudgeAfterSilentHours);
  return silent.map((contact) => buildNudge(contact, config.nudgeAfterSilentHours));
}

function buildNudge(contact: UrgencyTableEntry, silentHours: number): RelationshipNudge {
  const hours = contact.lastMessageAt
    ? Math.round((Date.now() - new Date(contact.lastMessageAt).getTime()) / (60 * 60 * 1000))
    : silentHours;

  const suggestion = contact.notes
    ? `Consider acknowledging ${contact.displayName} for: ${contact.notes}`
    : `It's been ${hours} hours since you last connected with ${contact.displayName}. Consider reaching out.`;

  return {
    contactName: contact.displayName,
    contactId: contact.rowKey,
    silentHours: hours,
    suggestion,
  };
}

// ---------------------------------------------------------------------------
// Silent archive helper
// ---------------------------------------------------------------------------

/**
 * Archive a system-noise message to Azure Table Storage.
 */
export async function archiveSystemNoise(
  ctx: MsgContext,
  storage: SovereignStorageClient,
): Promise<void> {
  const now = new Date();
  const entity: ArchivedNoiseEntity = {
    partitionKey: now.toISOString().slice(0, 10), // YYYY-MM-DD
    rowKey: ctx.MessageSid ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    provider: ctx.Provider ?? ctx.Surface ?? "unknown",
    senderId: ctx.SenderId ?? ctx.From ?? "unknown",
    senderName: ctx.SenderName,
    body: ctx.Body ?? "",
    receivedAt: now.toISOString(),
    sessionKey: ctx.SessionKey,
  };
  await storage.archiveNoise(entity);
}

// ---------------------------------------------------------------------------
// Sovereign dispatch wrapper
// ---------------------------------------------------------------------------

/** Outcome of sovereign-filter processing for one inbound message. */
export type SovereignFilterOutcome =
  | { action: "deliver-raw"; classification: "priority-human" }
  | { action: "batch"; classification: "known-human" }
  | { action: "archive"; classification: "system-noise" };

/**
 * Run the sovereign filter on an inbound message context.
 *
 * Returns the recommended action:
 *   - `deliver-raw` → pass through immediately, no AI summarization.
 *   - `batch` → enqueue for scheduled delivery.
 *   - `archive` → silently store in Azure Table Storage.
 *
 * Side effects:
 *   - Updates `lastMessageAt` for known contacts.
 *   - Archives system-noise messages.
 *   - Enqueues batched messages.
 */
export async function applySovereignFilter(
  ctx: MsgContext,
  storage: SovereignStorageClient,
  batchQueue: MessageBatchQueue,
): Promise<SovereignFilterOutcome> {
  const { classification } = await classifySender(ctx, storage);

  switch (classification) {
    case "priority-human": {
      // Update last-message timestamp (fire-and-forget)
      void storage.touchContactLastMessage(ctx.SenderId ?? ctx.From ?? "");
      return { action: "deliver-raw", classification: "priority-human" };
    }
    case "known-human": {
      // Update last-message timestamp
      void storage.touchContactLastMessage(ctx.SenderId ?? ctx.From ?? "");

      // Enqueue for batched delivery
      batchQueue.enqueue({
        senderId: ctx.SenderId ?? ctx.From ?? "",
        senderName: ctx.SenderName,
        body: ctx.Body ?? "",
        provider: ctx.Provider ?? ctx.Surface,
        receivedAt: new Date().toISOString(),
        sessionKey: ctx.SessionKey,
        originatingChannel: ctx.OriginatingChannel,
        originatingTo: ctx.OriginatingTo,
      });
      return { action: "batch", classification: "known-human" };
    }
    case "system-noise": {
      // Archive silently
      await archiveSystemNoise(ctx, storage);
      return { action: "archive", classification: "system-noise" };
    }
  }
}
