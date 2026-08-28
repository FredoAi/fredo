# Mission Monitor functional tests

- [ ] FM-9 FIX-CHAT-TOOLS: Run a unique-marker Run CLI session that produces at least two tool calls and a final answer. Verify DOM and screenshot order USER → TOOLS → RESPONSE, with THINKING (if present) between USER and TOOLS; reconcile the rendered nodes to the marker-resolved telemetry_spans session tree.
- [ ] FM-10 FIX-CHAT-NOTOOLS: Run a unique-marker zero-tool session. Verify DOM and screenshot show USER immediately followed by RESPONSE with no TOOLS header, empty box, or orphan divider; reconcile to telemetry_spans.
- [ ] FM-11 FIX-L3: Run a unique-marker three-level delegation fixture with sibling subagents. Verify screenshot and DOM bounding boxes show every SubagentNode to the right of chats, non-overlapping, and sibling gaps ≥24px; reconcile node set to telemetry_spans.
- [ ] AC5 FIX-L4: Run a four-to-five-level fixture and verify rightward progression, no collisions, pan/zoom/select interaction, and telemetry_spans receipt.
