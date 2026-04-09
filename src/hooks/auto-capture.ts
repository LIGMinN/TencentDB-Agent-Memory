/**
 * auto-capture hook (v3): records conversation messages locally (L0),
 * then notifies the MemoryPipelineManager for L1/L2/L3 scheduling.
 *
 * Key design decisions:
 * - Always write L0 locally via l0-recorder.
 * - When VectorStore + EmbeddingService are available, also write L0 vector index.
 * - Notify MemoryPipelineManager for L1/L2/L3 trigger evaluation.
 * - L1 Runner reads from VectorStore DB (primary) or L0 JSONL files (fallback).
 * - Extraction is NOT triggered here. The pipeline manager decides when.
 */

import crypto from "node:crypto";
import type { MemoryTdaiConfig } from "../config.js";
import { CheckpointManager } from "../utils/checkpoint.js";
import type { MemoryPipelineManager } from "../utils/pipeline-manager.js";
import { recordConversation } from "../conversation/l0-recorder.js";
import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { VectorStore, L0VectorRecord } from "../store/vector-store.js";
import type { EmbeddingService } from "../store/embedding.js";

const TAG = "[memory-tdai] [capture]";

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface AutoCaptureResult {
  /** Whether the scheduler was notified (conversation count incremented) */
  schedulerNotified: boolean;
  /** Number of messages recorded to L0 */
  l0RecordedCount: number;
  /** Number of L0 message vectors written */
  l0VectorsWritten: number;
  /** Filtered messages for L1 immediate use */
  filteredMessages: ConversationMessage[];
}

/**
 * Generate a unique L0 record ID for vector indexing.
 * Includes an index to distinguish multiple messages within the same round.
 */
function generateL0RecordId(sessionKey: string, index: number): string {
  return `l0_${sessionKey}_${Date.now()}_${index}_${crypto.randomBytes(3).toString("hex")}`;
}

export async function performAutoCapture(params: {
  messages: unknown[];
  sessionKey: string;
  sessionId?: string;
  cfg: MemoryTdaiConfig;
  pluginDataDir: string;
  logger?: Logger;
  scheduler?: MemoryPipelineManager;
  /** Clean original user prompt from before_prompt_build cache (pre-prependContext). */
  originalUserText?: string;
  /**
   * Number of messages in the session at before_prompt_build time.
   * Used by l0-recorder to locate the exact user message that originalUserText
   * corresponds to: rawMessages[originalUserMessageCount] is the polluted user message.
   */
  originalUserMessageCount?: number;
  /** Epoch ms when the plugin was registered (cold-start time).
   *  Used as fallback cursor when checkpoint has no prior timestamp —
   *  prevents the first agent_end from dumping all session history into L0. */
  pluginStartTimestamp?: number;
  /** VectorStore for L0 vector indexing (optional). */
  vectorStore?: VectorStore;
  /** EmbeddingService for L0 vector indexing (optional). */
  embeddingService?: EmbeddingService;
}): Promise<AutoCaptureResult> {
  const {
    messages, sessionKey, sessionId, cfg, pluginDataDir, logger, scheduler,
    originalUserText, originalUserMessageCount, pluginStartTimestamp,
    vectorStore, embeddingService,
  } = params;
  const tCaptureStart = performance.now();

  const checkpoint = new CheckpointManager(pluginDataDir, logger);

  // ============================
  // Step 1 + 2: L0 recording + checkpoint update (ATOMIC)
  // ============================
  // These steps are combined inside captureAtomically() to prevent the race
  // condition where two concurrent agent_end events both read the same stale
  // cursor and produce duplicate L0 records. The file lock is held for the
  // entire read-cursor → recordConversation → advance-cursor sequence.
  const tL0RecordStart = performance.now();
  let filteredMessages: ConversationMessage[] = [];
  try {
    await checkpoint.captureAtomically(
      sessionKey,
      pluginStartTimestamp,
      async (afterTimestamp) => {
        logger?.debug?.(`${TAG} L0 capture cursor (per-session, atomic): afterTimestamp=${afterTimestamp} session=${sessionKey}`);

        if (afterTimestamp === pluginStartTimestamp && pluginStartTimestamp && pluginStartTimestamp > 0) {
          logger?.debug?.(
            `${TAG} No per-session checkpoint cursor found for session=${sessionKey} — ` +
            `using pluginStartTimestamp as floor: ` +
            `${afterTimestamp} (${new Date(afterTimestamp).toISOString()})`,
          );
        }

        filteredMessages = await recordConversation({
          sessionKey,
          sessionId,
          rawMessages: messages,
          baseDir: pluginDataDir,
          logger,
          originalUserText,
          afterTimestamp,
          originalUserMessageCount,
        });

        if (filteredMessages.length === 0) {
          return null; // Nothing captured — cursor stays unchanged
        }

        logger?.debug?.(`${TAG} L0 recorded: ${filteredMessages.length} messages for session ${sessionKey}`);
        const maxTs = Math.max(...filteredMessages.map((m) => m.timestamp));
        return { maxTimestamp: maxTs, messageCount: filteredMessages.length };
      },
    );
  } catch (err) {
    logger?.error(`${TAG} L0 recording failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const tL0RecordEnd = performance.now();

  // ============================
  // Step 1.5: L0 vector indexing — metadata written synchronously,
  //           embedding done in background (non-blocking)
  // ============================
  // PERF FIX: Remote embedding API calls (2-3s each) were blocking
  // the agent_end hook, adding 5-9s latency per conversation round.
  // Now we:
  //   1. Write L0 metadata + FTS immediately (no embedding) — ~10ms
  //   2. Fire off background task to embed + update vectors (non-blocking)
  // This way the user gets their response immediately.
  const tL0VecStart = performance.now();
  let l0VectorsWritten = 0;
  logger?.debug?.(
    `${TAG} [L0-vec-index] Check: filteredMessages=${filteredMessages.length}, ` +
    `vectorStore=${vectorStore ? "available" : "UNAVAILABLE"}, ` +
    `embeddingService=${embeddingService ? "available" : "UNAVAILABLE"}`,
  );

  // Pre-generate L0 records and write metadata synchronously (fast path)
  const l0Records: Array<{ record: L0VectorRecord; content: string }> = [];
  if (filteredMessages.length > 0 && vectorStore) {
    const now = new Date().toISOString();
    logger?.debug?.(`${TAG} [L0-vec-index] START indexing ${filteredMessages.length} message(s) for session ${sessionKey}`);
    for (let i = 0; i < filteredMessages.length; i++) {
      const msg = filteredMessages[i];
      try {
        const l0Record: L0VectorRecord = {
          id: generateL0RecordId(sessionKey, i),
          sessionKey,
          sessionId: sessionId || "",
          role: msg.role,
          messageText: msg.content,
          recordedAt: now,
          timestamp: msg.timestamp,
        };

        // Write metadata + FTS immediately WITHOUT embedding (fast, ~ms)
        const upsertOk = vectorStore.upsertL0(l0Record, undefined);
        if (upsertOk) {
          l0VectorsWritten++;
          l0Records.push({ record: l0Record, content: msg.content });
        } else {
          logger?.warn(`${TAG} [L0-vec-index] upsertL0 returned false for message ${i}`);
        }
      } catch (err) {
        logger?.warn?.(`${TAG} [L0-vec-index] FAILED for message ${i} (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    logger?.debug?.(`${TAG} [L0-vec-index] DONE: ${l0VectorsWritten}/${filteredMessages.length} metadata records written (sync)`);

    // Fire-and-forget: batch embed + update vectors in background
    if (l0Records.length > 0 && embeddingService) {
      const bgVectorStore = vectorStore; // capture for closure
      const bgEmbeddingService = embeddingService;
      const bgRecords = [...l0Records]; // snapshot
      const bgLogger = logger;

      // Do NOT await — this runs in background after response is sent
      void (async () => {
        const tBgStart = performance.now();
        try {
          // Use embedBatch for a single API call instead of N sequential calls
          const texts = bgRecords.map((r) => r.content);
          const embeddings = await bgEmbeddingService.embedBatch(texts);

          let bgUpdated = 0;
          for (let i = 0; i < bgRecords.length; i++) {
            try {
              const ok = bgVectorStore.updateL0Embedding(bgRecords[i].record.id, embeddings[i]);
              if (ok) bgUpdated++;
            } catch (err) {
              bgLogger?.warn?.(
                `${TAG} [L0-vec-index-bg] Failed to update embedding for ${bgRecords[i].record.id}: ` +
                `${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          const bgMs = performance.now() - tBgStart;
          bgLogger?.debug?.(
            `${TAG} [L0-vec-index-bg] Background embedding complete: ${bgUpdated}/${bgRecords.length} vectors updated (${bgMs.toFixed(0)}ms)`,
          );
        } catch (err) {
          const bgMs = performance.now() - tBgStart;
          bgLogger?.warn?.(
            `${TAG} [L0-vec-index-bg] Background embedding failed (${bgMs.toFixed(0)}ms, non-fatal): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    }
  } else if (filteredMessages.length > 0) {
    logger?.warn(`${TAG} [L0-vec-index] SKIPPED: vectorStore not available`);
  }
  const tL0VecEnd = performance.now();

  // ============================
  // Step 3: Notify scheduler of this conversation round
  // ============================
  const tNotifyStart = performance.now();
  // Pass empty array: L1 Runner reads from VectorStore DB (or L0 JSONL fallback), not from in-memory buffers.
  if (scheduler) {
    await scheduler.notifyConversation(sessionKey, []);
    logger?.debug?.(`${TAG} Scheduler notified of conversation round (sessionKey=${sessionKey})`);

    const totalMs = performance.now() - tCaptureStart;
    logger?.info(
      `${TAG} ⏱ Capture timing: total=${totalMs.toFixed(0)}ms, ` +
      `l0Record+checkpoint=${(tL0RecordEnd - tL0RecordStart).toFixed(0)}ms, ` +
      `l0VecIndex=${(tL0VecEnd - tL0VecStart).toFixed(0)}ms ` +
      `(metadata-only, embed=background, msgs=${filteredMessages.length}), ` +
      `notify=${(performance.now() - tNotifyStart).toFixed(0)}ms`,
    );

    return {
      schedulerNotified: true,
      l0RecordedCount: filteredMessages.length,
      l0VectorsWritten,
      filteredMessages,
    };
  }

  const totalMs = performance.now() - tCaptureStart;
  logger?.info(
    `${TAG} ⏱ Capture timing: total=${totalMs.toFixed(0)}ms, ` +
    `l0Record+checkpoint=${(tL0RecordEnd - tL0RecordStart).toFixed(0)}ms, ` +
    `l0VecIndex=${(tL0VecEnd - tL0VecStart).toFixed(0)}ms ` +
    `(metadata-only, embed=background, msgs=${filteredMessages.length}), ` +
    `notify=${(performance.now() - tNotifyStart).toFixed(0)}ms`,
  );

  logger?.debug?.(`${TAG} No scheduler provided, skipping notification`);
  return {
    schedulerNotified: false,
    l0RecordedCount: filteredMessages.length,
    l0VectorsWritten,
    filteredMessages,
  };
}
