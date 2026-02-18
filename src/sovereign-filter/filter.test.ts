import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { SovereignStorageClient } from "./storage.js";
import type { UrgencyTableEntry } from "./types.js";
import {
  classifySender,
  MessageBatchQueue,
  applySovereignFilter,
  generateRelationshipNudges,
  archiveSystemNoise,
} from "./filter.js";
import { DEFAULT_SOVEREIGN_FILTER_CONFIG } from "./types.js";

// ---------------------------------------------------------------------------
// Mock storage client factory
// ---------------------------------------------------------------------------

function createMockStorage(contacts: Map<string, UrgencyTableEntry> = new Map()) {
  return {
    getContact: vi.fn(async (id: string) => contacts.get(id)),
    listContacts: vi.fn(async () => [...contacts.values()]),
    listPriorityContacts: vi.fn(async () => [...contacts.values()].filter((c) => c.isPriority)),
    upsertContact: vi.fn(async () => {}),
    touchContactLastMessage: vi.fn(async () => {}),
    archiveNoise: vi.fn(async () => {}),
    findSilentContacts: vi.fn(async (hours: number) => {
      const cutoff = Date.now() - hours * 60 * 60 * 1000;
      return [...contacts.values()].filter((c) => {
        if (!c.lastMessageAt) {
          return true;
        }
        return new Date(c.lastMessageAt).getTime() < cutoff;
      });
    }),
  } satisfies {
    [K in keyof SovereignStorageClient]: SovereignStorageClient[K];
  };
}

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Body: "hello",
    From: "user-123",
    SenderId: "user-123",
    SenderName: "Alice",
    Provider: "telegram",
    Surface: "telegram",
    SessionKey: "agent:telegram:user:user-123",
    ChatType: "direct",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifySender
// ---------------------------------------------------------------------------

describe("classifySender", () => {
  it("returns priority-human when sender is in urgency table with isPriority", async () => {
    const contacts = new Map<string, UrgencyTableEntry>([
      [
        "user-123",
        {
          partitionKey: "contacts",
          rowKey: "user-123",
          displayName: "Alice",
          isPriority: true,
        },
      ],
    ]);
    const storage = createMockStorage(contacts);
    const result = await classifySender(buildCtx(), storage);

    expect(result.classification).toBe("priority-human");
    expect(result.contactEntry?.displayName).toBe("Alice");
  });

  it("returns known-human when sender is in urgency table without isPriority", async () => {
    const contacts = new Map<string, UrgencyTableEntry>([
      [
        "user-123",
        {
          partitionKey: "contacts",
          rowKey: "user-123",
          displayName: "Bob",
          isPriority: false,
        },
      ],
    ]);
    const storage = createMockStorage(contacts);
    const result = await classifySender(buildCtx(), storage);

    expect(result.classification).toBe("known-human");
  });

  it("returns system-noise when sender is not in urgency table", async () => {
    const storage = createMockStorage();
    const result = await classifySender(buildCtx(), storage);

    expect(result.classification).toBe("system-noise");
  });

  it("returns system-noise when sender id is empty", async () => {
    const storage = createMockStorage();
    const result = await classifySender(buildCtx({ SenderId: "", From: "" }), storage);

    expect(result.classification).toBe("system-noise");
  });

  it("falls back to From when SenderId is not set", async () => {
    const contacts = new Map<string, UrgencyTableEntry>([
      [
        "from-456",
        {
          partitionKey: "contacts",
          rowKey: "from-456",
          displayName: "Carol",
          isPriority: true,
        },
      ],
    ]);
    const storage = createMockStorage(contacts);
    const result = await classifySender(
      buildCtx({ SenderId: undefined, From: "from-456" }),
      storage,
    );

    expect(result.classification).toBe("priority-human");
  });
});

// ---------------------------------------------------------------------------
// MessageBatchQueue
// ---------------------------------------------------------------------------

describe("MessageBatchQueue", () => {
  let queue: MessageBatchQueue;

  beforeEach(() => {
    queue = new MessageBatchQueue();
  });

  it("starts empty", () => {
    expect(queue.size).toBe(0);
    expect(queue.peek()).toEqual([]);
  });

  it("enqueues and drains messages", () => {
    queue.enqueue({
      senderId: "a",
      body: "hello",
      receivedAt: new Date().toISOString(),
    });
    queue.enqueue({
      senderId: "b",
      body: "world",
      receivedAt: new Date().toISOString(),
    });

    expect(queue.size).toBe(2);

    const batch = queue.drain();
    expect(batch).toHaveLength(2);
    expect(batch[0]?.body).toBe("hello");
    expect(batch[1]?.body).toBe("world");

    // Queue should be empty after drain
    expect(queue.size).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  it("peek does not remove messages", () => {
    queue.enqueue({
      senderId: "a",
      body: "peek me",
      receivedAt: new Date().toISOString(),
    });
    expect(queue.peek()).toHaveLength(1);
    expect(queue.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// applySovereignFilter
// ---------------------------------------------------------------------------

describe("applySovereignFilter", () => {
  it("delivers priority-human messages immediately", async () => {
    const contacts = new Map<string, UrgencyTableEntry>([
      [
        "user-123",
        {
          partitionKey: "contacts",
          rowKey: "user-123",
          displayName: "Alice",
          isPriority: true,
        },
      ],
    ]);
    const storage = createMockStorage(contacts);
    const queue = new MessageBatchQueue();

    const outcome = await applySovereignFilter(buildCtx(), storage, queue);

    expect(outcome.action).toBe("deliver-raw");
    expect(outcome.classification).toBe("priority-human");
    expect(queue.size).toBe(0); // not batched
    expect(storage.touchContactLastMessage).toHaveBeenCalledWith("user-123");
  });

  it("batches known-human messages", async () => {
    const contacts = new Map<string, UrgencyTableEntry>([
      [
        "user-123",
        {
          partitionKey: "contacts",
          rowKey: "user-123",
          displayName: "Bob",
          isPriority: false,
        },
      ],
    ]);
    const storage = createMockStorage(contacts);
    const queue = new MessageBatchQueue();

    const outcome = await applySovereignFilter(buildCtx(), storage, queue);

    expect(outcome.action).toBe("batch");
    expect(outcome.classification).toBe("known-human");
    expect(queue.size).toBe(1);
    expect(queue.peek()[0]?.body).toBe("hello");
  });

  it("archives system-noise messages", async () => {
    const storage = createMockStorage();
    const queue = new MessageBatchQueue();

    const outcome = await applySovereignFilter(buildCtx(), storage, queue);

    expect(outcome.action).toBe("archive");
    expect(outcome.classification).toBe("system-noise");
    expect(storage.archiveNoise).toHaveBeenCalled();
    expect(queue.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// archiveSystemNoise
// ---------------------------------------------------------------------------

describe("archiveSystemNoise", () => {
  it("creates an archive entity with correct fields", async () => {
    const storage = createMockStorage();
    const ctx = buildCtx({ MessageSid: "msg-abc", Body: "system alert" });

    await archiveSystemNoise(ctx, storage);

    expect(storage.archiveNoise).toHaveBeenCalledTimes(1);
    const entity = storage.archiveNoise.mock.calls[0]?.[0];
    expect(entity).toBeDefined();
    expect(entity.rowKey).toBe("msg-abc");
    expect(entity.body).toBe("system alert");
    expect(entity.provider).toBe("telegram");
    expect(entity.senderId).toBe("user-123");
  });

  it("generates a fallback rowKey when MessageSid is missing", async () => {
    const storage = createMockStorage();
    const ctx = buildCtx({ MessageSid: undefined });

    await archiveSystemNoise(ctx, storage);

    const entity = storage.archiveNoise.mock.calls[0]?.[0];
    expect(entity.rowKey).toBeTruthy();
    expect(entity.rowKey).not.toBe("undefined");
  });
});

// ---------------------------------------------------------------------------
// generateRelationshipNudges
// ---------------------------------------------------------------------------

describe("generateRelationshipNudges", () => {
  it("generates nudges for contacts that have gone silent", async () => {
    const fourDaysAgo = new Date(Date.now() - 96 * 60 * 60 * 1000).toISOString();
    const contacts = new Map<string, UrgencyTableEntry>([
      [
        "old-friend",
        {
          partitionKey: "contacts",
          rowKey: "old-friend",
          displayName: "Dave",
          isPriority: true,
          lastMessageAt: fourDaysAgo,
          notes: "helped with the Azure migration",
        },
      ],
    ]);
    const storage = createMockStorage(contacts);

    const nudges = await generateRelationshipNudges(storage, {
      ...DEFAULT_SOVEREIGN_FILTER_CONFIG,
      nudgeAfterSilentHours: 72,
    });

    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.contactName).toBe("Dave");
    expect(nudges[0]?.suggestion).toContain("Azure migration");
  });

  it("does not nudge for recently active contacts", async () => {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const contacts = new Map<string, UrgencyTableEntry>([
      [
        "active-friend",
        {
          partitionKey: "contacts",
          rowKey: "active-friend",
          displayName: "Eve",
          isPriority: true,
          lastMessageAt: oneHourAgo,
        },
      ],
    ]);
    const storage = createMockStorage(contacts);

    const nudges = await generateRelationshipNudges(storage, {
      ...DEFAULT_SOVEREIGN_FILTER_CONFIG,
      nudgeAfterSilentHours: 72,
    });

    expect(nudges).toHaveLength(0);
  });

  it("nudges contacts with no lastMessageAt (never communicated)", async () => {
    const contacts = new Map<string, UrgencyTableEntry>([
      [
        "new-contact",
        {
          partitionKey: "contacts",
          rowKey: "new-contact",
          displayName: "Frank",
          isPriority: false,
        },
      ],
    ]);
    const storage = createMockStorage(contacts);

    const nudges = await generateRelationshipNudges(storage);

    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.contactName).toBe("Frank");
  });
});
