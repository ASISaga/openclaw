/**
 * Azure Table Storage client for the Sovereign Filter.
 *
 * Manages two tables:
 *   - `sovereignurgency` – the urgency/priority contact list (source of truth).
 *   - `sovereignarchive` – silent archive for system-noise messages.
 *
 * Environment variable:
 *   AZURE_STORAGE_CONNECTION_STRING – connection string for the storage account.
 */

import { TableClient } from "@azure/data-tables";
import type { ArchivedNoiseEntity, SovereignFilterConfig, UrgencyTableEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Table names (must match Bicep template)
// ---------------------------------------------------------------------------
export const TABLE_URGENCY = "sovereignurgency";
export const TABLE_ARCHIVE = "sovereignarchive";

// ---------------------------------------------------------------------------
// Partition keys
// ---------------------------------------------------------------------------
const PK_CONTACTS = "contacts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConnectionString(config?: SovereignFilterConfig): string {
  const cs = config?.azureStorageConnectionString ?? process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) {
    throw new Error(
      "AZURE_STORAGE_CONNECTION_STRING is required for the Sovereign Filter Azure storage client",
    );
  }
  return cs;
}

/** Normalize a sender id for use as an Azure Table row key (no /, \\, #, ?). */
export function normalizeRowKey(raw: string): string {
  return encodeURIComponent(raw).replace(/%/g, "$");
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class SovereignStorageClient {
  private urgencyClient: TableClient;
  private archiveClient: TableClient;

  constructor(config?: SovereignFilterConfig) {
    const cs = getConnectionString(config);
    this.urgencyClient = TableClient.fromConnectionString(cs, TABLE_URGENCY);
    this.archiveClient = TableClient.fromConnectionString(cs, TABLE_ARCHIVE);
  }

  // ---- Urgency table (contacts) ------------------------------------------

  /**
   * Look up a contact by sender identifier.
   * Returns `undefined` if the sender is not in the urgency table.
   */
  async getContact(senderId: string): Promise<UrgencyTableEntry | undefined> {
    try {
      const entity = await this.urgencyClient.getEntity<UrgencyTableEntry>(
        PK_CONTACTS,
        normalizeRowKey(senderId),
      );
      return entity as UrgencyTableEntry;
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        return undefined;
      }
      throw err;
    }
  }

  /** List all contacts in the urgency table. */
  async listContacts(): Promise<UrgencyTableEntry[]> {
    const results: UrgencyTableEntry[] = [];
    const entities = this.urgencyClient.listEntities<UrgencyTableEntry>({
      queryOptions: { filter: `PartitionKey eq '${PK_CONTACTS}'` },
    });
    for await (const entity of entities) {
      results.push(entity as UrgencyTableEntry);
    }
    return results;
  }

  /** List only priority contacts. */
  async listPriorityContacts(): Promise<UrgencyTableEntry[]> {
    const all = await this.listContacts();
    return all.filter((c) => c.isPriority);
  }

  /** Upsert a contact into the urgency table. */
  async upsertContact(entry: UrgencyTableEntry): Promise<void> {
    await this.urgencyClient.upsertEntity(
      { ...entry, partitionKey: PK_CONTACTS, rowKey: normalizeRowKey(entry.rowKey) },
      "Merge",
    );
  }

  /** Update the last-message timestamp for a contact. */
  async touchContactLastMessage(senderId: string): Promise<void> {
    const key = normalizeRowKey(senderId);
    try {
      await this.urgencyClient.updateEntity(
        {
          partitionKey: PK_CONTACTS,
          rowKey: key,
          lastMessageAt: new Date().toISOString(),
        },
        "Merge",
      );
    } catch (err: unknown) {
      // If contact doesn't exist yet, silently ignore.
      if (!isNotFoundError(err)) {
        throw err;
      }
    }
  }

  // ---- Silent archive ----------------------------------------------------

  /** Archive a system-noise message. */
  async archiveNoise(entity: ArchivedNoiseEntity): Promise<void> {
    await this.archiveClient.upsertEntity(entity, "Replace");
  }

  // ---- Relationship maintenance ------------------------------------------

  /**
   * Find contacts that haven't been communicated with recently.
   * Returns contacts where `lastMessageAt` is older than `silentHours` ago.
   */
  async findSilentContacts(silentHours: number): Promise<UrgencyTableEntry[]> {
    const contacts = await this.listContacts();
    const cutoff = Date.now() - silentHours * 60 * 60 * 1000;
    return contacts.filter((c) => {
      if (!c.lastMessageAt) {
        return true; // never messaged → suggest reconnection
      }
      return new Date(c.lastMessageAt).getTime() < cutoff;
    });
  }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function isNotFoundError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "statusCode" in err) {
    return (err as { statusCode: number }).statusCode === 404;
  }
  return false;
}
