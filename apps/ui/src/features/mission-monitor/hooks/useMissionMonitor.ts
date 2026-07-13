import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useNodesState, useEdgesState } from 'reactflow';
import type { Node, Edge, NodeChange } from 'reactflow';
import type { ContractDelivery } from '../../../shared/classes/EventSubscription';
import {
  isChatNodeDelivery,
  isToolUseDelivery,
  makeToolNodePayload,
  makeSubagentNodePayload,
  extractDeliveryPayload,
  deliverySessionId,
  deliveryCorrelationId,
  extractUserMessage,
  extractAgentReply,
  extractAgentThinking,
  extractTokenCounts,
  extractAgentModel,
  filterSubagentOutput,
  type GraphNodeStatus,
  type GraphNodeType,
  type GraphEdgeType,
  type AgentNodePayload,
  type SubagentNodePayload,
  type ToolNodePayload,
  type FileNodePayload,
} from '../lib/contract';
import { graphStatusToMonitorStatus, GRAPH_NODE_TYPE_MAP } from '../types';
import type { MonitorNodeData, MonitorNodeStatus } from '../types';
import { customEventStore } from '../lib/contract_555';
import type { CustomEventData } from '../lib/contract_555';
import { computeForceLayout } from '../lib/layout';

// ── Edge style definitions ────────────────────────────────────────────────────

const EDGE_STYLES: Record<GraphEdgeType, React.CSSProperties> = {
  parent:  { stroke: '#6366f1', strokeWidth: 1.5 },
  calls:   { stroke: '#a855f7', strokeWidth: 1.5 },
  reads:   { stroke: '#334155', strokeDasharray: '2,4', strokeWidth: 1 },
  writes:  { stroke: '#334155', strokeDasharray: '2,4', strokeWidth: 1 },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgentNodePayload(d: ContractDelivery): AgentNodePayload {
  const raw = extractDeliveryPayload(d);
  const p = raw as Record<string, any>;

  // REQ-4: Extract all fields using normalization helpers that check
  // Hook nested paths (properties.text, properties.info.text, etc.)
  const userMessage = extractUserMessage(p);
  let agentReply = extractAgentReply(p);
  const agentThinking = extractAgentThinking(p);
  const { promptTokens, completionTokens } = extractTokenCounts(p);
  const { agent, model } = extractAgentModel(p);

  // Safety: agentReply must not be the same as userMessage.
  // For UserPromptSubmit events, properties.text is the user's prompt
  // — but extractAgentReply() also finds it there. For all other events
  // (session.next.text.ended, chat.message), properties.text is the
  // agent's response, so there's no conflict. Only clear for
  // UserPromptSubmit events where the fields genuinely collide.
  const eventType = p.event_type as string | undefined;
  if (eventType === 'UserPromptSubmit' && userMessage && agentReply === userMessage) {
    agentReply = '';
  }

  return {
    agent,
    model,
    userMessage,
    agentThinking,
    agentReply,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    correlationId: deliveryCorrelationId(d),
    sessionId: deliverySessionId(d),
  };
}

function makeAgentNodeLabel(_payload: AgentNodePayload): string {
  return 'Chat';
}

function extractSubagents(
  d: ContractDelivery,
  parentCorrelationId: string,
): SubagentNodePayload[] {
  const p = extractDeliveryPayload(d);
  const subagents = (p.subagents as any[]) ?? [];
  return subagents.map((sa: any, i: number) => ({
    name: sa.name ?? sa.subagentName ?? `subagent-${i}`,
    instruction: sa.instruction ?? sa.prompt ?? '',
    output: sa.output ?? '',
    parentCorrelationId,
    correlationId: `${parentCorrelationId}-sa-${i}`,
    sessionId: deliverySessionId(d),
  }));
}

function extractTools(
  d: ContractDelivery,
  parentCorrelationId: string,
): ToolNodePayload[] {
  const p = extractDeliveryPayload(d);
  const tools = (p.tools as any[]) ?? [];
  return tools.map((t: any, i: number) => ({
    toolName: t.name ?? t.toolName ?? `tool-${i}`,
    input: t.input ?? t.input ?? '',
    output: t.output ?? t.output ?? '',
    parentCorrelationId,
    correlationId: `${parentCorrelationId}-tool-${i}`,
    sessionId: deliverySessionId(d),
  }));
}

function extractFiles(
  d: ContractDelivery,
  parentToolId: string,
): FileNodePayload[] {
  const p = extractDeliveryPayload(d);
  const files = (p.files as any[]) ?? [];
  return files.map((f: any, i: number) => ({
    filePath: f.path ?? f.filePath ?? f.file ?? `file-${i}`,
    operation: (f.operation === 'write' || f.operation === 'read') ? f.operation : 'read',
    parentToolId,
    sessionId: deliverySessionId(d),
  }));
}

function makeMonitorNodeData(
  id: string,
  nodeType: GraphNodeType,
  status: GraphNodeStatus,
  payload: any,
  timestamp: string,
  label: string,
): MonitorNodeData {
  return {
    eventType: nodeType,
    status: graphStatusToMonitorStatus(status),
    payload: payload as Record<string, any>,
    timestamp,
    label,
    threadId: 'main',
    relatedEvents: [],
  };
}

function makeReactFlowNode(
  id: string,
  nodeType: GraphNodeType,
  status: GraphNodeStatus,
  payload: any,
  timestamp: string,
  label: string,
): Node<MonitorNodeData> {
  return {
    id,
    type: GRAPH_NODE_TYPE_MAP[nodeType],
    position: { x: 0, y: 0 },
    data: makeMonitorNodeData(id, nodeType, status, payload, timestamp, label),
  };
}

function makeReactFlowEdge(
  id: string,
  source: string,
  target: string,
  edgeType: GraphEdgeType,
): Edge {
  return {
    id,
    source,
    target,
    type: 'smoothstep',
    animated: edgeType === 'calls',
    hidden: false,
    style: EDGE_STYLES[edgeType],
  };
}

// ── Graph builder state (internal, per-session) ──────────────────────────────

interface GraphBuilderState {
  agentNodes: Map<string, { payload: AgentNodePayload; status: GraphNodeStatus; timestamp: string }>;
  subagentNodes: Map<string, { payload: SubagentNodePayload; status: GraphNodeStatus; timestamp: string }>;
  toolNodes: Map<string, { payload: ToolNodePayload; status: GraphNodeStatus; timestamp: string }>;
  fileNodes: Map<string, { payload: FileNodePayload; status: GraphNodeStatus; timestamp: string }>;
  nodeOrder: string[];
  agentOrder: string[];
}

function createInitialGraphBuilderState(): GraphBuilderState {
  return {
    agentNodes: new Map(),
    subagentNodes: new Map(),
    toolNodes: new Map(),
    fileNodes: new Map(),
    nodeOrder: [],
    agentOrder: [],
  };
}

/**
 * Process a single ContractDelivery through the graph builder.
 * Routes deliveries by contractName to the appropriate handler:
 * - chat-node → AgentNode lifecycle
 * - tool-use-lifecycle → ToolNode lifecycle + FileNode extraction
 * - subagent-lifecycle → SubagentNode lifecycle
 */
function processDelivery(
  state: GraphBuilderState,
  delivery: ContractDelivery,
): GraphBuilderState {
  const correlationId = deliveryCorrelationId(delivery);
  const sessionId = deliverySessionId(delivery);
  const lifecycle = delivery.lifecycle;

  // Clone state
  const next: GraphBuilderState = {
    agentNodes: new Map(state.agentNodes),
    subagentNodes: new Map(state.subagentNodes),
    toolNodes: new Map(state.toolNodes),
    fileNodes: new Map(state.fileNodes),
    nodeOrder: [...state.nodeOrder],
    agentOrder: [...state.agentOrder],
  };

  const contractName = delivery.contractName;

  if (contractName === 'chat-node') {
    if (lifecycle === 'init') {
      const rawP = extractDeliveryPayload(delivery) as Record<string, any>;

      // REQ-12: Detect subagent chat-node deliveries by comparing correlationId
      // with sessionId. With adapter rewrite, subagent events have sessionId =
      // parent_sid and correlationId = child_sid → they differ. Parent agent
      // deliveries have sessionId = parent_sid and correlationId = parent_sid →
      // they're equal.
      // Spec #555 (Compaction AC-7): When testing compaction via mock events
      // (fredo emit), ensure sessionId === correlationId for parent agent nodes.
      // Using different values triggers the isSubagentSession branch, creating
      // a SubagentNode instead of an AgentNode. While the compaction status
      // should still be applied to the SubagentNode, verifying the correct
      // extraction requires the 'payload' stream field to survive ECE delivery.
      const isSubagentSession = deliveryCorrelationId(delivery) !== deliverySessionId(delivery);

      if (isSubagentSession) {
        // REQ-5 (Bug #509): Filter out internal OpenCode tool-execution
        // agent sessions (build, plan). These are NOT user-requested
        // @-subagent dispatches and should not create SubagentNodes.
        // Belt-and-suspenders: the adapter-level fix in opencode.rs
        // prevents sessionId rewrite for these agents, but this check
        // catches edge cases where internal sessions slip through.
        const subInfo = rawP?.properties?.info as Record<string, any> | undefined;
        const agentName = subInfo?.agent as string | undefined;
        if (agentName === 'build' || agentName === 'plan') {
          // Internal tool-execution agent — skip SubagentNode creation.
          // These events flow normally (correlationId === sessionId after
          // adapter fix) and should not have reached this branch, but
          // this guard prevents spurious SubagentNodes if they do.
          return next;
        }

        // Create a SubagentNode for this subagent session.
        // The parent sessionId is deliverySessionId (rewritten at adapter level).
        const parentSid = deliverySessionId(delivery);

        // Find the parent agent's correlationId by searching agent nodes
        // that have the same sessionId as the parent.
        let parentCorrId = '';
        if (state.agentOrder.length > 0) {
          // Try the most recently created agent first
          const lastAgentId = state.agentOrder[state.agentOrder.length - 1];
          const lastAgent = state.agentNodes.get(lastAgentId);
          if (lastAgent?.payload.sessionId === parentSid) {
            parentCorrId = lastAgentId;
          }
        }
        if (!parentCorrId) {
          // Fallback: scan all agent nodes for matching parent sessionId
          for (const [key, val] of state.agentNodes) {
            if (val.payload.sessionId === parentSid) {
              parentCorrId = key;
              break;
            }
          }
        }

        const subagentPayload: SubagentNodePayload = {
          name: (subInfo?.agent as string) ?? (subInfo?.title as string) ?? 'Subagent',
          instruction: (subInfo?.title as string) ?? '',
          output: '',
          parentCorrelationId: parentCorrId,
          correlationId,
          // sessionId is the parent sessionId (rewritten at adapter level)
          sessionId: deliverySessionId(delivery),
        };

        next.subagentNodes.set(correlationId, {
          payload: subagentPayload,
          status: 'in-progress',
          timestamp: delivery.timestamp,
        });
        if (!next.nodeOrder.includes(`subagent:${correlationId}`)) {
          next.nodeOrder.push(`subagent:${correlationId}`);
        }

        // Clean up any existing ToolNode for 'task' that shares
        // the same parent agent (from PreToolUse fire before session.created).
        for (const [toolKey, toolVal] of next.toolNodes) {
          if (toolVal.payload.toolName === 'task' && toolVal.payload.parentCorrelationId === parentCorrId) {
            next.toolNodes.delete(toolKey);
            next.nodeOrder = next.nodeOrder.filter(id => id !== `tool:${toolKey}`);
          }
        }

        return next;
      }

      // Don't recreate if already exists
      if (next.agentNodes.has(correlationId)) return next;

      const payload = makeAgentNodePayload(delivery);

      // REQ-4: On init, if this is a UserPromptSubmit event, the
      // extractAgentReply() function will incorrectly find the user's
      // prompt text at payload.properties?.text and set it as agentReply.
      // Clear it — the actual agent response will arrive on subsequent
      // update/end deliveries. The user message is preserved via the
      // merge logic that never overwrites userMessage from init.
      if (rawP['event_type'] === 'UserPromptSubmit') {
        payload.agentReply = '';
        payload.agentThinking = '';
      }

      next.agentNodes.set(correlationId, {
        payload,
        status: 'in-progress',
        timestamp: delivery.timestamp,
      });

      if (!next.agentOrder.includes(correlationId)) {
        next.agentOrder.push(correlationId);
      }
      if (!next.nodeOrder.includes(`agent:${correlationId}`)) {
        next.nodeOrder.push(`agent:${correlationId}`);
      }

      // Extract subagents from chat-node payload
      for (const sa of extractSubagents(delivery, correlationId)) {
        if (!next.subagentNodes.has(sa.correlationId)) {
          next.subagentNodes.set(sa.correlationId, {
            payload: sa,
            status: 'in-progress',
            timestamp: delivery.timestamp,
          });
          if (!next.nodeOrder.includes(`subagent:${sa.correlationId}`)) {
            next.nodeOrder.push(`subagent:${sa.correlationId}`);
          }
        }
      }

      // Extract tools from chat-node payload
      for (const t of extractTools(delivery, correlationId)) {
        if (!next.toolNodes.has(t.correlationId)) {
          next.toolNodes.set(t.correlationId, {
            payload: t,
            status: 'in-progress',
            timestamp: delivery.timestamp,
          });
          if (!next.nodeOrder.includes(`tool:${t.correlationId}`)) {
            next.nodeOrder.push(`tool:${t.correlationId}`);
          }
        }
      }

      // Extract files from chat-node payload
      for (const t of extractTools(delivery, correlationId)) {
        const toolId = t.correlationId;
        for (const f of extractFiles(delivery, toolId)) {
          const fileId = `${toolId}-file-${f.filePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
          if (!next.fileNodes.has(fileId)) {
            next.fileNodes.set(fileId, {
              payload: { ...f },
              status: 'active',
              timestamp: delivery.timestamp,
            });
            if (!next.nodeOrder.includes(fileId)) {
              next.nodeOrder.push(fileId);
            }
          }
        }
      }
    } else if (lifecycle === 'update') {
      // Spec #382: Handle subagent session updates — the subagent was created
      // as a SubagentNode from chat-node (session.created init with parentID).
      const subExisting = next.subagentNodes.get(correlationId);
      if (subExisting) {
        const rawP = extractDeliveryPayload(delivery);
        // REQ-3: Diagnostic logging for subagent update deliveries
        const rawKeys = Object.keys(rawP);
        console.debug('[subagent-update] correlationId:', correlationId, 'lifecycle:', lifecycle, 'rawP keys:', rawKeys, 'has part.text:', typeof (rawP as any).part?.text === 'string', 'has text:', typeof (rawP as any).text === 'string', 'has state.output:', typeof (rawP as any).state?.output === 'string', 'has part.state.output:', typeof (rawP as any).part?.state?.output === 'string');
        // Extract agent reply text from message.part.updated (text) events
        const agentReply = extractAgentReply(rawP);
        console.debug('[subagent-update] extractAgentReply result:', agentReply ? `"${agentReply.slice(0, 100)}"` : '(empty)');
        // AC-6 (Spec #478): Accumulate raw output AND filter progressively.
        // End lifecycle may never fire for subagent sessions, so filtering
        // must happen as text streams in. filterSubagentOutput is safe on
        // partial text — returns original if no response sentences found.
        if (agentReply) {
          subExisting.payload.output = subExisting.payload.output
            ? subExisting.payload.output + agentReply
            : agentReply;
          subExisting.payload.output = filterSubagentOutput(
            subExisting.payload.output,
            subExisting.payload.instruction,
          );
        }
        const { promptTokens, completionTokens } = extractTokenCounts(rawP);
        if (promptTokens > 0 || completionTokens > 0) {
          // Tokens are stored in subagent node payload as extra fields for display
          (subExisting.payload as any).promptTokens = Math.max((subExisting.payload as any).promptTokens ?? 0, promptTokens);
          (subExisting.payload as any).completionTokens = Math.max((subExisting.payload as any).completionTokens ?? 0, completionTokens);
          (subExisting.payload as any).totalTokens = ((subExisting.payload as any).promptTokens ?? 0) + ((subExisting.payload as any).completionTokens ?? 0);
        }
        // REQ-8: Detect compacted flag from delivery payload
        const compactedRaw = rawP as Record<string, any>;
        const subIsCompacted = compactedRaw?.compacted === true;
        next.subagentNodes.set(correlationId, {
          ...subExisting,
          status: subIsCompacted ? 'compacted' as GraphNodeStatus : 'active' as GraphNodeStatus,
          timestamp: delivery.timestamp,
        });
        return next;
      }

      const existing = next.agentNodes.get(correlationId);
      if (existing) {
        // If the node is already 'complete', only merge token/content
        // data — do NOT regress the status back to 'active' or overwrite
        // content fields with potentially incorrect values from
        // post-completion events.
        // AC-5 (Spec #478): When node is already 'complete', do NOT overwrite
        // the accumulated agentReply. Use concatenation logic to preserve text
        // from prior lifecycle updates. The status 'complete' may be hit when
        // the processing useEffect re-runs (due to mapping changes) and
        // re-processes deliveries that were already handled — overwriting would
        // lose the accumulated text.
        if (existing.status === 'complete') {
          const rawP = extractDeliveryPayload(delivery);
          const { promptTokens, completionTokens } = extractTokenCounts(rawP);
          if (promptTokens > 0 || completionTokens > 0) {
            existing.payload.promptTokens = Math.max(existing.payload.promptTokens, promptTokens);
            existing.payload.completionTokens = Math.max(existing.payload.completionTokens, completionTokens);
            existing.payload.totalTokens = existing.payload.promptTokens + existing.payload.completionTokens;
          }
          // AC-5: Append new agentReply to existing, never overwrite.
          // Use the same concatenation-with-dedup logic as the non-complete branch.
          const newPayload = makeAgentNodePayload(delivery);
          if (newPayload.agentReply && newPayload.agentReply !== existing.payload.userMessage) {
            if (existing.payload.agentReply) {
              if (!existing.payload.agentReply.includes(newPayload.agentReply)) {
                // Normalize whitespace for comparison before appending
                const normalizedExisting = existing.payload.agentReply.replace(/\s+/g, ' ');
                const normalizedNew = newPayload.agentReply.replace(/\s+/g, ' ');
                if (!normalizedExisting.includes(normalizedNew) && !normalizedNew.includes(normalizedExisting.slice(-normalizedNew.length))) {
                  existing.payload.agentReply += newPayload.agentReply;
                }
              }
            } else {
              existing.payload.agentReply = newPayload.agentReply;
            }
          }
          if (newPayload.agentThinking) {
            existing.payload.agentThinking = newPayload.agentThinking || existing.payload.agentThinking;
          }
          // Spec #382: If init had empty userMessage (from session.created),
          // allow update to populate it (from chat.message output.message.parts[0].text)
          if (!existing.payload.userMessage && newPayload.userMessage) {
            existing.payload.userMessage = newPayload.userMessage;
          }
          return next;
        }

        const newPayload = makeAgentNodePayload(delivery);
        // REQ-8: Merge update payload with existing — preserve fields not present in update
        // IMPORTANT: userMessage is set ONCE on init and must NEVER be overwritten.
        // Subsequent deliveries (session.next.text.*, message.*) carry agent response
        // text in payload.properties.text, which extractUserMessage would incorrectly
        // return as the user message. Always preserve the init value.
        //
        // Spec #382: Concatenate agentReply across multiple update deliveries.
        // Each message.part.updated event carries one text chunk in the ECE delivery's
        // payload. The ECE overwrites accumulated_payload per event, so each update
        // delivery only carries the latest chunk. Using || would replace the previous
        // chunk. Concatenation accumulates the full response text.
        const concatenatedAgentReply = newPayload.agentReply
          ? (existing.payload.agentReply
              ? existing.payload.agentReply + newPayload.agentReply
              : newPayload.agentReply)
          : existing.payload.agentReply;
        const mergedPayload: AgentNodePayload = {
          ...existing.payload,
          ...newPayload,
          // Preserve userMessage from init UNLESS init was empty and new is non-empty.
          // session.created (init) has no prompt text — the real prompt arrives in
          // chat.message (update/end). Always use the non-empty value.
          userMessage: newPayload.userMessage || existing.payload.userMessage,
          agentThinking: newPayload.agentThinking || existing.payload.agentThinking,
          agentReply: concatenatedAgentReply,
          // Preserve token counts if the update didn't provide them, using Math.max
          promptTokens: Math.max(existing.payload.promptTokens, newPayload.promptTokens),
          completionTokens: Math.max(existing.payload.completionTokens, newPayload.completionTokens),
          totalTokens: Math.max(existing.payload.totalTokens, newPayload.totalTokens),
        };
        // REQ-8: Detect compacted flag from delivery payload
        const updateInner = extractDeliveryPayload(delivery) as Record<string, any>;
        const isCompacted = updateInner?.compacted === true;
        next.agentNodes.set(correlationId, {
          payload: mergedPayload,
          status: isCompacted ? 'compacted' as GraphNodeStatus : 'active' as GraphNodeStatus,
          timestamp: delivery.timestamp,
        });
      }

      // Update status for existing subagents/tools/files to active
      for (const [key, val] of next.subagentNodes) {
        next.subagentNodes.set(key, { ...val, status: 'active' });
      }
      for (const [key, val] of next.toolNodes) {
        next.toolNodes.set(key, { ...val, status: 'active' });
      }
    } else if (lifecycle === 'end') {
      // Spec #382: Handle subagent session completion
      const subExisting = next.subagentNodes.get(correlationId);
      if (subExisting) {
        const rawP = extractDeliveryPayload(delivery);
        // REQ-3: Diagnostic logging for subagent end deliveries
        const rawKeysEnd = Object.keys(rawP);
        console.debug('[subagent-end] correlationId:', correlationId, 'lifecycle:', lifecycle, 'rawP keys:', rawKeysEnd, 'has part.text:', typeof (rawP as any).part?.text === 'string', 'has text:', typeof (rawP as any).text === 'string');
        const agentReply = extractAgentReply(rawP);
        console.debug('[subagent-end] extractAgentReply result:', agentReply ? `"${agentReply.slice(0, 100)}"` : '(empty)');
        // AC-6 (Spec #478): Accumulate raw end delivery output, then filter
        // the full accumulated text. Filtering at end lifecycle ensures
        // filterSubagentOutput sees the complete text for prefix matching,
        // double-newline detection, and sentence-level heuristics.
        if (agentReply) {
          subExisting.payload.output = subExisting.payload.output
            ? subExisting.payload.output + agentReply
            : agentReply;
        }
        // After accumulating all output, filter the full text at end lifecycle
        const filteredOutput = filterSubagentOutput(subExisting.payload.output, subExisting.payload.instruction);
        subExisting.payload.output = filteredOutput;
        const { promptTokens, completionTokens } = extractTokenCounts(rawP);
        if (promptTokens > 0 || completionTokens > 0) {
          (subExisting.payload as any).promptTokens = Math.max((subExisting.payload as any).promptTokens ?? 0, promptTokens);
          (subExisting.payload as any).completionTokens = Math.max((subExisting.payload as any).completionTokens ?? 0, completionTokens);
          (subExisting.payload as any).totalTokens = ((subExisting.payload as any).promptTokens ?? 0) + ((subExisting.payload as any).completionTokens ?? 0);
        }
        // REQ-8: Detect compacted flag from delivery payload
        const subEndRaw = rawP as Record<string, any>;
        const subEndCompacted = subEndRaw?.compacted === true;
        next.subagentNodes.set(correlationId, {
          ...subExisting,
          status: subEndCompacted ? 'compacted' as GraphNodeStatus : 'complete' as GraphNodeStatus,
          timestamp: delivery.timestamp,
        });
        return next;
      }

      const existing = next.agentNodes.get(correlationId);
      if (existing) {
        // AC-5 (Spec #478): When node is already 'complete', do NOT overwrite
        // the accumulated agentReply. This branch is hit when the processing
        // useEffect re-runs (due to mapping changes) and re-processes deliveries
        // that were already handled — overwriting would lose accumulated text.
        if (existing.status === 'complete') {
          const rawP = extractDeliveryPayload(delivery);
          const { promptTokens, completionTokens } = extractTokenCounts(rawP);
          if (promptTokens > 0 || completionTokens > 0) {
            existing.payload.promptTokens = Math.max(existing.payload.promptTokens, promptTokens);
            existing.payload.completionTokens = Math.max(existing.payload.completionTokens, completionTokens);
            existing.payload.totalTokens = existing.payload.promptTokens + existing.payload.completionTokens;
          }
          // AC-5: Append new agentReply to existing, never overwrite.
          const newPayload = makeAgentNodePayload(delivery);
          if (newPayload.agentReply && newPayload.agentReply !== existing.payload.userMessage) {
            if (existing.payload.agentReply) {
              if (!existing.payload.agentReply.includes(newPayload.agentReply)) {
                const normalizedExisting = existing.payload.agentReply.replace(/\s+/g, ' ');
                const normalizedNew = newPayload.agentReply.replace(/\s+/g, ' ');
                if (!normalizedExisting.includes(normalizedNew) && !normalizedNew.includes(normalizedExisting.slice(-normalizedNew.length))) {
                  existing.payload.agentReply += newPayload.agentReply;
                }
              }
            } else {
              existing.payload.agentReply = newPayload.agentReply;
            }
          }
          // REQ-8: If the delivery marks this node as compacted, upgrade
          // the status even though the node is already 'complete'.
          const completeRawP = rawP as Record<string, any>;
          if (completeRawP?.compacted === true) {
            existing.status = 'compacted' as GraphNodeStatus;
          }
          return next;
        }

        const finalStatus: GraphNodeStatus = 'complete';
        const newPayload = makeAgentNodePayload(delivery);
        newPayload.endTime = delivery.timestamp;
        // REQ-8: Merge end delivery with existing — preserve fields not present
        // IMPORTANT: userMessage is set ONCE on init and must NEVER be overwritten.
        //
        // On end deliveries, the delivery's agentReply ALWAYS wins over the
        // existing value. The existing agentReply may be incorrectly set to the
        // user's prompt text (from UserPromptSubmit events where extractAgentReply
        // finds the prompt at payload.properties.text). The real agent response
        // from session.next.text.ended must override it.
        const mergedPayload: AgentNodePayload = {
          ...existing.payload,
          ...newPayload,
          // Preserve userMessage from init UNLESS init was empty.
          // session.created (init) has no prompt text — the real prompt arrives
          // in chat.message (end delivery). Use the non-empty value.
          userMessage: newPayload.userMessage || existing.payload.userMessage,
          agentThinking: newPayload.agentThinking || existing.payload.agentThinking,
          // REQ-4 (Spec #478): Concatenate end delivery's agentReply with existing,
          // preserving all text across the full lifecycle. Dedup: if existing already
          // contains the new text, skip concatenation to avoid duplicates.
          agentReply: newPayload.agentReply
            ? (existing.payload.agentReply
                ? (existing.payload.agentReply.includes(newPayload.agentReply)
                    ? existing.payload.agentReply
                    : existing.payload.agentReply + newPayload.agentReply)
                : newPayload.agentReply)
            : existing.payload.agentReply,
          promptTokens: newPayload.promptTokens || existing.payload.promptTokens,
          completionTokens: newPayload.completionTokens || existing.payload.completionTokens,
          totalTokens: newPayload.totalTokens || existing.payload.totalTokens,
        };
        // REQ-8: Detect compacted flag — override finalStatus with 'compacted'
        const endInner = extractDeliveryPayload(delivery) as Record<string, any>;
        const endCompacted = endInner?.compacted === true;
        next.agentNodes.set(correlationId, {
          payload: mergedPayload,
          status: endCompacted ? 'compacted' as GraphNodeStatus : finalStatus,
          timestamp: delivery.timestamp,
        });

        // Mark subagents and tools under this agent as complete.
        // AC-6 (Spec #478): Also filter subagent output — belt-and-suspenders
        // for cases where progressive update filtering missed content.
        for (const [key, val] of next.subagentNodes) {
          if (val.payload.parentCorrelationId === correlationId) {
            next.subagentNodes.set(key, {
              ...val,
              status: 'complete',
              payload: {
                ...val.payload,
                output: filterSubagentOutput(val.payload.output, val.payload.instruction),
              },
            });
          }
        }
        for (const [key, val] of next.toolNodes) {
          if (val.payload.parentCorrelationId === correlationId) {
            next.toolNodes.set(key, { ...val, status: 'complete' });
          }
        }
      } else {
        // If no existing agent node, mark matching ones as complete
        for (const [key, val] of next.agentNodes) {
          if (key === correlationId) {
            next.agentNodes.set(key, { ...val, status: 'complete' });
          }
        }
      }
    }
  } else if (contractName === 'tool-use-lifecycle') {
    // REQ-5: Skip message.* streaming events — they carry EventType::Chat and
    // should not create tool nodes. These reach the handler via contracts that
    // don't yet have eventType filters (waiting for backend REQ-2).
    const deliveryToolName = delivery.payload?.['toolName'] as string | undefined;
    if (deliveryToolName && deliveryToolName.startsWith('message.')) {
      return next;
    }

    // Spec #382 AC-4: Suppress ToolNode for 'task' tool — subagent dispatch is
    // represented by the SubagentNode created in the chat-node handler from
    // session.created events with parentID. The 'task' tool IS the subagent
    // dispatch mechanism; a separate ToolNode is redundant.
    if (deliveryToolName === 'task') {
      return next;
    }

    // Determine parent correlation ID: try inner payload first, then last agent,
    // then fallback to the first agent node sharing the same sessionId.
    const innerPayload = delivery.payload?.['payload'] as Record<string, unknown> | undefined;
    const parentCorrelationId =
      (innerPayload?.parentCorrelationId as string) ??
      (() => {
        // Try agentOrder last, then fallback to first agent in same session
        if (state.agentOrder.length > 0) return state.agentOrder[state.agentOrder.length - 1];
        for (const [key, val] of next.agentNodes) {
          if (val.payload.sessionId === deliverySessionId(delivery)) return key;
        }
        return '';
      })();

    // If a subagent node with the same correlationId exists, skip creating
    // a tool node — the subagent takes priority for this tool invocation.
    if (next.subagentNodes.has(correlationId)) return next;

    if (lifecycle === 'init') {
      if (next.toolNodes.has(correlationId)) return next;

      const payload = makeToolNodePayload(delivery, parentCorrelationId);
      next.toolNodes.set(correlationId, {
        payload,
        status: 'in-progress',
        timestamp: delivery.timestamp,
      });
      if (!next.nodeOrder.includes(`tool:${correlationId}`)) {
        next.nodeOrder.push(`tool:${correlationId}`);
      }

      // Extract files from tool payload
      for (const f of extractFiles(delivery, correlationId)) {
        const fileId = `${correlationId}-file-${f.filePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
        if (!next.fileNodes.has(fileId)) {
          next.fileNodes.set(fileId, {
            payload: { ...f },
            status: 'active',
            timestamp: delivery.timestamp,
          });
          if (!next.nodeOrder.includes(fileId)) {
            next.nodeOrder.push(fileId);
          }
        }
      }
    } else if (lifecycle === 'update') {
      const existing = next.toolNodes.get(correlationId);
      if (existing) {
        const newPayload = makeToolNodePayload(delivery, parentCorrelationId);
        // REQ-8: Merge update payload with existing
        const mergedPayload: ToolNodePayload = {
          ...existing.payload,
          ...newPayload,
          input: newPayload.input || existing.payload.input,
          output: newPayload.output || existing.payload.output,
        };
        next.toolNodes.set(correlationId, {
          payload: mergedPayload,
          status: 'active',
          timestamp: delivery.timestamp,
        });

        // Extract files from tool payload on update too
        for (const f of extractFiles(delivery, correlationId)) {
          const fileId = `${correlationId}-file-${f.filePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
          if (!next.fileNodes.has(fileId)) {
            next.fileNodes.set(fileId, {
              payload: { ...f },
              status: 'active',
              timestamp: delivery.timestamp,
            });
            if (!next.nodeOrder.includes(fileId)) {
              next.nodeOrder.push(fileId);
            }
          }
        }
      }
    } else if (lifecycle === 'end') {
      const existing = next.toolNodes.get(correlationId);
      if (existing) {
        const hasOutput = !!(existing.payload.output || delivery.payload?.['payload']);
        const timedOut = delivery.timedOut;
        const finalStatus: GraphNodeStatus =
          timedOut ? 'error' :
          hasOutput ? 'complete' :
          'error';
        const payload = makeToolNodePayload(delivery, parentCorrelationId);
        next.toolNodes.set(correlationId, {
          payload,
          status: finalStatus,
          timestamp: delivery.timestamp,
        });
      }
    }
  } else if (contractName === 'custom-event') {
    // REQ-11: Store custom event deliveries in module-scoped Map keyed by sessionId.
    // No ReactFlow nodes are created — display deferred to a future phase.
    const inner = extractDeliveryPayload(delivery) as Record<string, any>;
    const eventData: CustomEventData = {
      deliveryId: delivery.id,
      toolName: (delivery.payload?.['toolName'] as string) ?? inner?.toolName as string ?? 'unknown',
      payload: inner ?? {},
      timestamp: delivery.timestamp,
      sessionId,
    };
    const existing = customEventStore.get(sessionId) ?? [];
    existing.push(eventData);
    customEventStore.set(sessionId, existing);
    // Return the cloned state — no graph topology changes for custom events.
    return next;
  }

  return next;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

interface UseDeliveryGraphOptions {
  deliveries: ContractDelivery[];
  sessionId: string | null;
}

/**
 * useDeliveryGraph — builds ReactFlow graph from ContractDelivery[].
 *
 * @param deliveries - All deliveries (filtered by sessionId internally)
 * @param sessionId - The selected session ID (null = no selection)
 * @returns nodes, edges, onNodesChange, onEdgesChange
 */
export function useDeliveryGraph({ deliveries, sessionId }: UseDeliveryGraphOptions) {
  const [layoutVersion, setLayoutVersion] = useState(0);
  const builderStateRef = useRef<GraphBuilderState>(createInitialGraphBuilderState());
  const lastSessionRef = useRef<string | null>(null);
  // AC-7: Cache layout positions to prevent jitter on re-render
  const layoutPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  // Track the last computed graph signature to detect structural changes
  const lastGraphRef = useRef<string>('');
  // Track last processed counts for incremental processing (perf: avoid O(N²) scans)
  const lastSessionProcessedRef = useRef(0);
  // Incremental session delivery filtering cache (perf: avoid O(N) re-filter on every delivery)
  const sessionDeliveriesCacheRef = useRef<ContractDelivery[]>([]);
  const sessionDeliveriesFilteredRef = useRef(0);
  // Reset graph state when session changes
  useEffect(() => {
    if (lastSessionRef.current !== sessionId) {
      builderStateRef.current = createInitialGraphBuilderState();
      lastSessionRef.current = sessionId;
      layoutPositionsRef.current = new Map();
      lastGraphRef.current = '';
      lastSessionProcessedRef.current = 0;
      sessionDeliveriesCacheRef.current = [];
      sessionDeliveriesFilteredRef.current = 0;
      setNodes([]);
      setEdges([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);



  // Filter deliveries by selected session (all contract types pass through).
  // PERF: Incremental filtering — only filter NEW deliveries on each render
  // instead of re-filtering the entire deliveries array (O(N) per delivery).
  // The deliveries array gets a new reference on every append (from StreamContext),
  // so depending on [deliveries, sessionId] re-runs this useMemo for every single
  // delivery. Using [deliveries.length, sessionId] only re-runs when new deliveries
  // arrive, with cached results in sessionDeliveriesCacheRef.
  const sessionDeliveries = useMemo(() => {
    if (!sessionId) {
      sessionDeliveriesCacheRef.current = [];
      sessionDeliveriesFilteredRef.current = 0;
      return [];
    }
    const startIdx = sessionDeliveriesFilteredRef.current;
    if (startIdx >= deliveries.length) return sessionDeliveriesCacheRef.current;

    // Only filter new deliveries since last time
    const newMatches: ContractDelivery[] = [];
    for (let i = startIdx; i < deliveries.length; i++) {
      const d = deliveries[i];
      if (deliverySessionId(d) === sessionId) {
        newMatches.push(d);
      }
    }
    sessionDeliveriesFilteredRef.current = deliveries.length;

    if (newMatches.length > 0) {
      sessionDeliveriesCacheRef.current = [...sessionDeliveriesCacheRef.current, ...newMatches];
    }
    return sessionDeliveriesCacheRef.current;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deliveries.length, sessionId]);

  // Process deliveries through the graph builder (INCREMENTAL).
  // PERF: Only process new deliveries since last render. Reprocessing all
  // deliveries from scratch on every effect run (O(N²) allocations via Map
  // clones) causes webview freezes with hundreds of deliveries.
  //
  // REQ-5: After processing, only build ReactFlow nodes for new and changed
  // entries rather than the full nodeOrder. REQ-6: Append edges incrementally
  // instead of replacing the full edge array.
  useEffect(() => {
    if (!sessionId || sessionDeliveries.length === 0) return;

    const startIdx = lastSessionProcessedRef.current;
    if (startIdx >= sessionDeliveries.length) return;

    let state = builderStateRef.current;

    // ── Phase 1: Incremental processDelivery with change tracking ──
    // REQ-5: Track which nodeOrder indices were affected by this batch.
    const prevNodeOrderLength = state.nodeOrder.length;
    // Track delivery correlationIds that touch existing nodes
    const touchedCorrIds = new Set<string>();
    // Track agent end lifecycles that also complete child subagent/tool nodes
    const agentEndCorrs = new Set<string>();

    // Only process new deliveries since last run
    for (let i = startIdx; i < sessionDeliveries.length; i++) {
      const d = sessionDeliveries[i];
      const corrId = deliveryCorrelationId(d);
      touchedCorrIds.add(corrId);
      if (d.contractName === 'chat-node' && d.lifecycle === 'end') {
        agentEndCorrs.add(corrId);
      }
      state = processDelivery(state, d);
    }
    lastSessionProcessedRef.current = sessionDeliveries.length;
    builderStateRef.current = state;

    // ── Phase 2: Determine which entry IDs are affected ──
    // NEW entries: appended to nodeOrder since last batch
    const newEntryIds = new Set(state.nodeOrder.slice(prevNodeOrderLength));

    // CHANGED entries: existing entries whose correlationId was touched by
    // the current batch's deliveries (status/payload updates).
    // Also include child subagent/tool nodes completed by agent end lifecycle.
    const changedEntryIds = new Set<string>();
    for (const entryId of state.nodeOrder) {
      if (newEntryIds.has(entryId)) continue;
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) continue; // file/legacy entries — no status delivery targets them
      const prefix = entryId.slice(0, colonIdx);
      const corrId = entryId.slice(colonIdx + 1);
      if (touchedCorrIds.has(corrId)) {
        changedEntryIds.add(entryId);
        continue;
      }
      // Agent end lifecycle marks child subagent/tool nodes as complete
      if (agentEndCorrs.size > 0) {
        if (prefix === 'subagent') {
          const entry = state.subagentNodes.get(corrId);
          if (entry && agentEndCorrs.has(entry.payload.parentCorrelationId)) {
            changedEntryIds.add(entryId);
          }
        } else if (prefix === 'tool') {
          const entry = state.toolNodes.get(corrId);
          if (entry && agentEndCorrs.has(entry.payload.parentCorrelationId)) {
            changedEntryIds.add(entryId);
          }
        }
      }
    }

    const affectedEntryIds = new Set([...newEntryIds, ...changedEntryIds]);

    // ── Phase 3: Build ReactFlow nodes only for affected entries (REQ-5) ──
    const nodeList: Node<MonitorNodeData>[] = [];

    for (const entryId of affectedEntryIds) {
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) {
        // Raw ID — file nodes or legacy entries (backward compat)
        if (state.fileNodes.has(entryId)) {
          const entry = state.fileNodes.get(entryId)!;
          nodeList.push(makeReactFlowNode(
            entryId, 'file', entry.status, entry.payload, entry.timestamp,
            `File: ${entry.payload.filePath.split('/').pop() ?? entry.payload.filePath}`,
          ));
        }
        continue;
      }

      const prefix = entryId.slice(0, colonIdx);
      const corrId = entryId.slice(colonIdx + 1);

      if (prefix === 'agent') {
        if (state.agentNodes.has(corrId)) {
          const entry = state.agentNodes.get(corrId)!;
          const label = makeAgentNodeLabel(entry.payload);
          nodeList.push(makeReactFlowNode(
            `agent-${corrId}`, 'agent', entry.status, entry.payload, entry.timestamp, label,
          ));
        }
      } else if (prefix === 'subagent') {
        if (state.subagentNodes.has(corrId)) {
          const entry = state.subagentNodes.get(corrId)!;
          nodeList.push(makeReactFlowNode(
            `subagent-${corrId}`, 'subagent', entry.status, entry.payload, entry.timestamp,
            `Subagent · ${entry.payload.name}`,
          ));
        }
      } else if (prefix === 'tool') {
        if (state.toolNodes.has(corrId)) {
          const entry = state.toolNodes.get(corrId)!;
          nodeList.push(makeReactFlowNode(
            `tool-${corrId}`, 'tool', entry.status, entry.payload, entry.timestamp,
            `Tool · ${entry.payload.toolName}`,
          ));
        }
      }
    }

    // ── Build lightweight layout data from FULL state (for graph signature) ──
    // Compute node depths via BFS across the ENTIRE graph structure.
    // This is O(N_total) but cheap — no ReactFlow Node object creation.
    const allNodeDepths = new Map<string, number>();
    const allNodeTypes = new Map<string, string>();
    const allLayoutEdges: { source: string; target: string }[] = [];

    for (const entryId of state.nodeOrder) {
      const colonIdx = entryId.indexOf(':');
      let nodeId: string;
      let nodeType: string;
      if (colonIdx < 0) {
        nodeId = entryId;
        nodeType = 'file';
      } else {
        const prefix = entryId.slice(0, colonIdx);
        const corrId = entryId.slice(colonIdx + 1);
        if (prefix === 'agent') { nodeId = `agent-${corrId}`; nodeType = 'agent'; }
        else if (prefix === 'subagent') { nodeId = `subagent-${corrId}`; nodeType = 'subagent'; }
        else if (prefix === 'tool') { nodeId = `tool-${corrId}`; nodeType = 'tool'; }
        else { nodeId = entryId; nodeType = 'file'; }
      }
      allNodeTypes.set(nodeId, nodeType);
      if (nodeType === 'agent') {
        allNodeDepths.set(nodeId, 0);
      }
    }

    // Build layout edges from ALL state
    for (const entryId of state.nodeOrder) {
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) {
        if (state.fileNodes.has(entryId)) {
          const entry = state.fileNodes.get(entryId)!;
          const parentToolId = `tool-${entry.payload.parentToolId}`;
          if (allNodeTypes.has(parentToolId) && allNodeTypes.has(entryId)) {
            allLayoutEdges.push({ source: parentToolId, target: entryId });
          }
        }
        continue;
      }
      const prefix = entryId.slice(0, colonIdx);
      const corrId = entryId.slice(colonIdx + 1);
      if (prefix === 'subagent') {
        const entry = state.subagentNodes.get(corrId);
        if (entry) {
          const parentId = entry.payload.parentCorrelationId ? `agent-${entry.payload.parentCorrelationId}` : '';
          const subagentId = `subagent-${corrId}`;
          if (parentId && allNodeTypes.has(parentId) && allNodeTypes.has(subagentId)) {
            allLayoutEdges.push({ source: parentId, target: subagentId });
          }
        }
      } else if (prefix === 'tool') {
        const entry = state.toolNodes.get(corrId);
        if (entry) {
          const parentId = entry.payload.parentCorrelationId ? `agent-${entry.payload.parentCorrelationId}` : '';
          const toolId = `tool-${corrId}`;
          if (parentId && allNodeTypes.has(parentId) && allNodeTypes.has(toolId)) {
            allLayoutEdges.push({ source: parentId, target: toolId });
          }
        }
      }
    }

    // BFS propagate depth from agent nodes (depth 0) along edges
    let bfsChanged = true;
    while (bfsChanged) {
      bfsChanged = false;
      for (const e of allLayoutEdges) {
        const sourceDepth = allNodeDepths.get(e.source);
        if (sourceDepth !== undefined && !allNodeDepths.has(e.target)) {
          allNodeDepths.set(e.target, sourceDepth + 1);
          bfsChanged = true;
        }
      }
    }
    for (const nodeId of allNodeTypes.keys()) {
      if (!allNodeDepths.has(nodeId)) {
        allNodeDepths.set(nodeId, 0);
      }
    }

    // Build lightweight layout nodes (id, status, depth, type) for graph signature
    const layoutNodes = Array.from(allNodeTypes.keys()).map((nodeId) => {
      const entryId = nodeId.startsWith('agent-') ? `agent:${nodeId.slice(6)}`
        : nodeId.startsWith('subagent-') ? `subagent:${nodeId.slice(9)}`
        : nodeId.startsWith('tool-') ? `tool:${nodeId.slice(5)}`
        : nodeId;
      const eci = entryId.indexOf(':');
      let status: MonitorNodeStatus = 'inactive';
      if (eci >= 0) {
        const prefix = entryId.slice(0, eci);
        const corrId = entryId.slice(eci + 1);
        const entry = prefix === 'agent' ? state.agentNodes.get(corrId)
          : prefix === 'subagent' ? state.subagentNodes.get(corrId)
          : prefix === 'tool' ? state.toolNodes.get(corrId)
          : undefined;
        if (entry) status = graphStatusToMonitorStatus(entry.status);
      }
      return {
        id: nodeId,
        status,
        depth: allNodeDepths.get(nodeId) ?? 0,
        type: allNodeTypes.get(nodeId) ?? 'agent',
      };
    });

    // AC-6: Only recompute layout when graph structure changes
    const graphSignature = layoutNodes.map(n => n.id).sort().join(',') + '|' +
      allLayoutEdges.map(e => `${e.source}>${e.target}`).sort().join(',');
    const needsRecompute = graphSignature !== lastGraphRef.current;

    if (needsRecompute || layoutPositionsRef.current.size === 0) {
      const layoutEdges = allLayoutEdges;
      const { positions, converged, iterations } = computeForceLayout(
        layoutNodes,
        layoutEdges,
        {
          maxIterations: 300,
          alphaMin: 0.01,
          alphaDecay: 0.02,
          existingPositions: layoutPositionsRef.current,
        },
      );
      layoutPositionsRef.current = positions;
      lastGraphRef.current = graphSignature;
    }

    // Apply cached positions to nodeList
    for (const node of nodeList) {
      const pos = layoutPositionsRef.current.get(node.id);
      if (pos) {
        node.position = { x: pos.x, y: pos.y };
      } else {
        node.position = { x: 0, y: 0 };
      }
    }

    // ── Phase 4: Build edges only for NEW entries (REQ-6) ──
    // Existing edges are preserved by the functional setEdges updater.
    // Edges for existing changed nodes don't change (parent-child topology
    // is established at node creation and is immutable).
    const edgeList: Edge[] = [];

    for (const entryId of newEntryIds) {
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) {
        // File nodes — create edges to parent tool
        if (state.fileNodes.has(entryId)) {
          const entry = state.fileNodes.get(entryId)!;
          const edgeType: GraphEdgeType = entry.payload.operation === 'write' ? 'writes' : 'reads';
          const parentToolId = `tool-${entry.payload.parentToolId}`;
          if (state.toolNodes.has(entry.payload.parentToolId)) {
            edgeList.push(makeReactFlowEdge(
              `e-${edgeType}-${parentToolId}-${entryId}`,
              parentToolId,
              entryId,
              edgeType,
            ));
          }
        }
        continue;
      }

      const prefix = entryId.slice(0, colonIdx);
      const corrId = entryId.slice(colonIdx + 1);

      if (prefix === 'subagent') {
        if (state.subagentNodes.has(corrId)) {
          const entry = state.subagentNodes.get(corrId)!;
          const subagentNodeId = `subagent-${corrId}`;
          const parentCorrId = entry.payload.parentCorrelationId;
          const parentId = parentCorrId ? `agent-${parentCorrId}` : '';
          if (parentId && state.agentNodes.has(parentCorrId)) {
            edgeList.push(makeReactFlowEdge(
              `e-parent-${parentId}-${subagentNodeId}`,
              parentId,
              subagentNodeId,
              'parent',
            ));
          }
        }
      } else if (prefix === 'tool') {
        if (state.toolNodes.has(corrId)) {
          const entry = state.toolNodes.get(corrId)!;
          const toolNodeId = `tool-${corrId}`;
          const parentCorrId = entry.payload.parentCorrelationId;
          const parentId = parentCorrId ? `agent-${parentCorrId}` : '';
          if (parentId && state.agentNodes.has(parentCorrId)) {
            edgeList.push(makeReactFlowEdge(
              `e-calls-${parentId}-${toolNodeId}`,
              parentId,
              toolNodeId,
              'calls',
            ));
          }
        }
      }
    }

    // ── Phase 5: Functional setNodes — merge new+changed into existing ──
    // REQ-5: Preserve unchanged nodes; add new; update changed; remove deleted.
    setNodes((currentNodes) => {
      const affectedIds = new Set(nodeList.map(n => n.id));
      const merged: Node<MonitorNodeData>[] = [];
      let changed = false;

      // Pass 1: Preserve existing nodes NOT in the affected set (unchanged)
      for (const existing of currentNodes) {
        if (!affectedIds.has(existing.id)) {
          // Verify the node still exists in state maps (defensive removal)
          const id = existing.id;
          const exists = id.startsWith('agent-') ? state.agentNodes.has(id.slice(6))
            : id.startsWith('subagent-') ? state.subagentNodes.has(id.slice(9))
            : id.startsWith('tool-') ? state.toolNodes.has(id.slice(5))
            : state.fileNodes.has(id);
          if (exists) {
            merged.push(existing);
          } else {
            changed = true; // entry was removed (e.g. agent→subagent conversion)
          }
        }
      }

      // Pass 2: Add/update nodes from affected set with deep compare
      for (const node of nodeList) {
        const idx = currentNodes.findIndex(n => n.id === node.id);
        if (idx >= 0) {
          const existing = currentNodes[idx];
          const posChanged = existing.position.x !== node.position.x ||
            existing.position.y !== node.position.y;
          const statusChanged = existing.data.status !== node.data.status;
          const payloadChanged = existing.data.payload !== node.data.payload;
          if (posChanged || statusChanged || payloadChanged) {
            merged.push({
              ...node,
              width: node.width ?? existing.width,
              height: node.height ?? existing.height,
            });
            changed = true;
          } else {
            merged.push(existing);
          }
        } else {
          merged.push(node);
          changed = true;
        }
      }

      return changed ? merged : currentNodes;
    });

    // ── Phase 6: Incremental edge update (REQ-6) ──
    // Append only new edges; never replace the full edge array.
    setEdges((currentEdges) => {
      const existingIds = new Set(currentEdges.map(e => e.id));
      const trulyNew = edgeList.filter(e => !existingIds.has(e.id));
      return trulyNew.length > 0 ? [...currentEdges, ...trulyNew] : currentEdges;
    });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionDeliveries, sessionId]);

  const [nodes, setNodes, rawOnNodesChange] = useNodesState<MonitorNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Stable ref for edges — prevents onNodesChange from depending on edges
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  // ── Force-directed layout (REQ-6/7) ─────────────────────────────────────────
  // Layout is computed in the processing useEffect above. onNodesChange is
  // a simple pass-through — no more vertical stacking. The Spec #275 guard
  // (setLayoutVersion only when layout actually changes) is handled by the
  // processing effect: it only runs when sessionDeliveries changes, not on
  // every dimension change.
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    rawOnNodesChange(changes);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _currentEdges = edgesRef.current;
  }, [rawOnNodesChange]);

  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    layoutVersion,
    eventCount: sessionDeliveries.length,
  };
}

// Re-export for backward compat (these are no-ops now)
export function buildGraphFromEvents(): { nodes: never[]; edges: never[] } {
  return { nodes: [], edges: [] };
}

export function processChatNodeSubscription(): any {
  return createInitialProcessorState();
}

export function createInitialProcessorState() {
  return {
    contracts: new Map(),
    assistantParentMap: new Map(),
    pendingParts: new Map(),
    toolPartIds: new Map(),
    filePaths: new Map(),
    nodeOrder: [],
    subagentContracts: new Map(),
  };
}
