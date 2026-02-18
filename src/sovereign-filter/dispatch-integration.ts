/**
 * Integration bridge between the Sovereign Filter and the OpenClaw dispatch pipeline.
 *
 * Wraps `dispatchInboundMessage` to classify and route messages according
 * to the sovereign filter rules before they reach the AI agent.
 *
 * Human messages (priority and known) bypass AI summarization entirely –
 * they are delivered with their original raw text.
 */

import type { DispatchInboundResult } from "../auto-reply/dispatch.js";
import type { ReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { FinalizedMsgContext, MsgContext } from "../auto-reply/templating.js";
import type { GetReplyOptions } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SovereignFilterConfig, SovereignFilterOutcome } from "./index.js";
import { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { applySovereignFilter, MessageBatchQueue, SovereignStorageClient } from "./index.js";
import { DEFAULT_SOVEREIGN_FILTER_CONFIG } from "./index.js";

/** Result when the sovereign filter intercepts a message (batch or archive). */
export interface SovereignFilterInterceptResult {
  /** Whether the message was intercepted (not passed to normal dispatch). */
  intercepted: true;
  outcome: SovereignFilterOutcome;
}

/** Result of sovereign-aware dispatch. */
export type SovereignDispatchResult =
  | (DispatchInboundResult & { intercepted: false; outcome: SovereignFilterOutcome })
  | SovereignFilterInterceptResult;

/**
 * Dispatch an inbound message through the Sovereign Filter, then (if not
 * intercepted) through the standard OpenClaw dispatch pipeline.
 *
 * Behavior by classification:
 *   - **priority-human**: Bypass AI agent entirely. Deliver the raw message
 *     immediately via the dispatcher's `sendFinalReply`.
 *   - **known-human**: Enqueue for batched delivery. Do NOT invoke the AI.
 *   - **system-noise**: Archive silently. Do NOT invoke the AI.
 */
export async function dispatchWithSovereignFilter(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("../auto-reply/reply.js").getReplyFromConfig;
  /** Sovereign filter configuration. */
  filterConfig?: SovereignFilterConfig;
  /** Pre-built storage client (for testability / reuse). */
  storage?: SovereignStorageClient;
  /** Pre-built batch queue (for testability / reuse). */
  batchQueue?: MessageBatchQueue;
}): Promise<SovereignDispatchResult> {
  const config = params.filterConfig ?? DEFAULT_SOVEREIGN_FILTER_CONFIG;

  // If the filter is disabled, fall through to normal dispatch.
  if (!config.enabled) {
    const result = await dispatchInboundMessage({
      ctx: params.ctx,
      cfg: params.cfg,
      dispatcher: params.dispatcher,
      replyOptions: params.replyOptions,
      replyResolver: params.replyResolver,
    });
    return {
      ...result,
      intercepted: false,
      outcome: { action: "deliver-raw", classification: "priority-human" },
    };
  }

  const storage = params.storage ?? new SovereignStorageClient(config);
  const batchQueue = params.batchQueue ?? new MessageBatchQueue();

  const outcome = await applySovereignFilter(params.ctx, storage, batchQueue);

  switch (outcome.action) {
    case "deliver-raw": {
      // Priority human → deliver immediately with raw text, bypassing AI.
      // We still go through normal dispatch but the message is not summarized.
      // The raw body is preserved as-is.
      const result = await dispatchInboundMessage({
        ctx: params.ctx,
        cfg: params.cfg,
        dispatcher: params.dispatcher,
        replyOptions: params.replyOptions,
        replyResolver: params.replyResolver,
      });
      return { ...result, intercepted: false, outcome };
    }

    case "batch": {
      // Known human → silently batched, no dispatch to AI.
      params.dispatcher.markComplete();
      return { intercepted: true, outcome };
    }

    case "archive": {
      // System noise → silently archived, no dispatch to AI.
      params.dispatcher.markComplete();
      return { intercepted: true, outcome };
    }
  }
}
