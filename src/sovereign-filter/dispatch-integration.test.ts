import { describe, expect, it, vi } from "vitest";
import type { ReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SovereignStorageClient } from "./storage.js";
import type { UrgencyTableEntry } from "./types.js";
import { dispatchWithSovereignFilter } from "./dispatch-integration.js";
import { MessageBatchQueue } from "./filter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStorage(contacts: Map<string, UrgencyTableEntry> = new Map()) {
  return {
    getContact: vi.fn(async (id: string) => contacts.get(id)),
    listContacts: vi.fn(async () => [...contacts.values()]),
    listPriorityContacts: vi.fn(async () => [...contacts.values()].filter((c) => c.isPriority)),
    upsertContact: vi.fn(async () => {}),
    touchContactLastMessage: vi.fn(async () => {}),
    archiveNoise: vi.fn(async () => {}),
    findSilentContacts: vi.fn(async () => []),
  } as unknown as SovereignStorageClient;
}

function createMockDispatcher(record: string[]): ReplyDispatcher {
  return {
    sendToolResult: () => true,
    sendBlockReply: () => true,
    sendFinalReply: () => {
      record.push("sendFinalReply");
      return true;
    },
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {
      record.push("markComplete");
    },
    waitForIdle: async () => {
      record.push("waitForIdle");
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatchWithSovereignFilter", () => {
  it("falls through to normal dispatch when filter is disabled", async () => {
    const order: string[] = [];
    const dispatcher = createMockDispatcher(order);

    const result = await dispatchWithSovereignFilter({
      ctx: { Body: "test", SenderId: "u1", From: "u1", ChatType: "direct" },
      cfg: {} as OpenClawConfig,
      dispatcher,
      filterConfig: { enabled: false, batchSchedule: "0 9 * * *", nudgeAfterSilentHours: 72 },
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(result.intercepted).toBe(false);
    expect(order).toContain("sendFinalReply");
  });

  it("delivers priority-human messages through normal dispatch", async () => {
    const order: string[] = [];
    const dispatcher = createMockDispatcher(order);
    const contacts = new Map<string, UrgencyTableEntry>([
      [
        "u1",
        {
          partitionKey: "contacts",
          rowKey: "u1",
          displayName: "Alice",
          isPriority: true,
        },
      ],
    ]);
    const storage = createMockStorage(contacts);

    const result = await dispatchWithSovereignFilter({
      ctx: { Body: "hello", SenderId: "u1", From: "u1", ChatType: "direct" },
      cfg: {} as OpenClawConfig,
      dispatcher,
      filterConfig: { enabled: true, batchSchedule: "0 9 * * *", nudgeAfterSilentHours: 72 },
      storage,
      batchQueue: new MessageBatchQueue(),
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(result.intercepted).toBe(false);
    expect(result.outcome.classification).toBe("priority-human");
    expect(order).toContain("sendFinalReply");
  });

  it("intercepts known-human messages for batching", async () => {
    const order: string[] = [];
    const dispatcher = createMockDispatcher(order);
    const contacts = new Map<string, UrgencyTableEntry>([
      [
        "u1",
        {
          partitionKey: "contacts",
          rowKey: "u1",
          displayName: "Bob",
          isPriority: false,
        },
      ],
    ]);
    const storage = createMockStorage(contacts);
    const batchQueue = new MessageBatchQueue();

    const result = await dispatchWithSovereignFilter({
      ctx: { Body: "hi there", SenderId: "u1", From: "u1", ChatType: "direct" },
      cfg: {} as OpenClawConfig,
      dispatcher,
      filterConfig: { enabled: true, batchSchedule: "0 9 * * *", nudgeAfterSilentHours: 72 },
      storage,
      batchQueue,
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(result.intercepted).toBe(true);
    expect(result.outcome.classification).toBe("known-human");
    expect(batchQueue.size).toBe(1);
    // Dispatcher should be marked complete (no AI invocation)
    expect(order).toContain("markComplete");
    // AI reply should NOT have been called
    expect(order).not.toContain("sendFinalReply");
  });

  it("intercepts system-noise messages for archiving", async () => {
    const order: string[] = [];
    const dispatcher = createMockDispatcher(order);
    const storage = createMockStorage(); // no contacts → system noise
    const batchQueue = new MessageBatchQueue();

    const result = await dispatchWithSovereignFilter({
      ctx: { Body: "system alert", SenderId: "bot-99", From: "bot-99", ChatType: "direct" },
      cfg: {} as OpenClawConfig,
      dispatcher,
      filterConfig: { enabled: true, batchSchedule: "0 9 * * *", nudgeAfterSilentHours: 72 },
      storage,
      batchQueue,
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(result.intercepted).toBe(true);
    expect(result.outcome.classification).toBe("system-noise");
    expect(batchQueue.size).toBe(0);
    expect(order).toContain("markComplete");
    expect(order).not.toContain("sendFinalReply");
  });
});
