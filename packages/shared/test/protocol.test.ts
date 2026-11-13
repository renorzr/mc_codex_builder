import test from "node:test";
import assert from "node:assert/strict";
import { clientMessageSchema, envelope, parseChatCommand } from "../src/index.js";

test("only explicit prefixes create tasks; validates control arguments", () => {
  assert.deepEqual(parseChatCommand("@CODEX 建一个塔"), { kind: "task", text: "建一个塔" });
  assert.deepEqual(parseChatCommand("!codex stop task-123"), { kind: "stop", taskId: "task-123" });
  assert.deepEqual(parseChatCommand("!codex approve"), { kind: "approve", taskId: undefined });
  assert.deepEqual(parseChatCommand("!codex reject"), { kind: "reject", taskId: undefined });
  assert.deepEqual(parseChatCommand("!codex approve task-123"), { kind: "approve", taskId: "task-123" });
  assert.deepEqual(parseChatCommand("!codex rollback"), { kind: "rollback", target: undefined });
  assert.deepEqual(parseChatCommand("!codex rollback abc123"), { kind: "rollback", target: "abc123" });
  for (const text of ["hello", "@codextra foo", "@codex", "!codex status junk", "!codex approve a b", "!codex rollback a b", "!codex unknown"]) {
    assert.throws(() => parseChatCommand(text));
  }
});

test("wire contract rejects wrong version, oversized text and extra fields", () => {
  const message = envelope("chat.command", { worldSessionId: "test-world", text: "@codex hello" });
  assert.equal(clientMessageSchema.safeParse(message).success, true);
  assert.equal(clientMessageSchema.safeParse({ ...message, protocolVersion: 2 }).success, false);
  assert.equal(clientMessageSchema.safeParse({ ...message, payload: { ...message.payload, token: "secret" } }).success, false);
  assert.equal(clientMessageSchema.safeParse({ ...message, payload: { ...message.payload, text: "x".repeat(8001) } }).success, false);
});

test("history is a bounded control command", () => {
  assert.deepEqual(parseChatCommand("!codex history"), { kind: "history", limit: 10 });
  assert.deepEqual(parseChatCommand("!codex history 50"), { kind: "history", limit: 50 });
  for (const input of ["0", "51", "-1", "1.5", "01", "10 more"]) assert.throws(() => parseChatCommand("!codex history " + input));
});
