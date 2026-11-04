import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOOK = new URL("../hooks/voice.mjs", import.meta.url).pathname;

const harness = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "RDS-"));
  const run = (event, input) => {
    const r = spawnSync("node", [HOOK, event], { input: JSON.stringify(input), env: { ...process.env, RDS_HOME: home } });
    assert.equal(r.status, 0, r.stderr.toString());
    const out = r.stdout.toString();
    return out ? JSON.parse(out) : null;
  };
  const say = (session_id, prompt) => run("UserPromptSubmit", { session_id, prompt });
  const context = (session_id, prompt) => say(session_id, prompt).hookSpecificOutput.additionalContext;
  const stop = (session_id, reply, extra = {}) => run("Stop", { session_id, last_assistant_message: reply, ...extra });
  return { home, run, say, context, stop };
};

const GOOD = "TAB: fix RDS hooks\n\nDone.\n\nELIR: Hooks now toggle voice.\n\nNo action needed on your end for this task.";

test("voice is on by default", () => {
  const h = harness();
  assert.match(h.context("a", "hello"), /RDS voice: ON \(set by default\)/);
});

test("free turns voice off for that reply only", () => {
  const h = harness();
  assert.match(h.context("a", "free: just tell me"), /OFF \(set by reply \(free\)\)/);
  assert.match(h.context("a", "next one"), /ON/);
});

test("session off affects only that session", () => {
  const h = harness();
  assert.match(h.say("a", "RDS session off").reason, /OFF \(set by session\)/);
  assert.match(h.context("a", "hi"), /OFF/);
  assert.match(h.context("b", "hi"), /ON/);
});

test("global off reaches every session, and session on beats it", () => {
  const h = harness();
  h.say("a", "RDS global off");
  assert.match(h.context("a", "hi"), /OFF \(set by global\)/);
  assert.match(h.context("b", "hi"), /OFF \(set by global\)/);
  h.say("b", "RDS session on");
  assert.match(h.context("b", "hi"), /ON \(set by session\)/);
  h.say("b", "RDS session reset");
  assert.match(h.context("b", "hi"), /OFF \(set by global\)/);
  h.say("a", "RDS global on");
  assert.match(h.context("a", "hi"), /ON \(set by default\)/);
});

test("switch keywords are blocked from reaching the model", () => {
  const h = harness();
  assert.equal(h.say("a", "RDS status").decision, "block");
  assert.equal(h.say("a", "rds Global OFF").decision, "block");
  assert.ok(h.say("a", "should RDS global off be a thing?").hookSpecificOutput);
});

test("stop rejects an off-contract reply while voice is on", () => {
  const h = harness();
  h.say("a", "hi");
  const r = h.stop("a", "Sure, here you go.");
  assert.equal(r.decision, "block");
  assert.match(r.reason, /TAB:.*ELIR:.*ending/);
  assert.equal(h.stop("a", GOOD), null);
  assert.equal(h.stop("a", "TAB: x\n\nELIR: y\n\n1. ship\n(silence = 1)"), null);
});

test("stop allows one retry, then lets the reply through", () => {
  const h = harness();
  h.say("a", "hi");
  assert.equal(h.stop("a", "plain", { stop_hook_active: true }), null);
});

test("stop stays quiet while voice is off", () => {
  const h = harness();
  h.say("a", "free answer please");
  assert.equal(h.stop("a", "plain"), null);
  h.say("a", "RDS session off");
  h.say("a", "hi");
  assert.equal(h.stop("a", "plain"), null);
});

test("stop reads the final reply from the transcript when no message field is given", () => {
  const h = harness();
  h.say("a", "hi");
  const transcript = path.join(h.home, "t.jsonl");
  const lines = [
    { type: "user", message: { content: "old prompt" } },
    { type: "assistant", message: { content: [{ type: "text", text: GOOD }] } },
    { type: "user", message: { content: "new prompt" } },
    { type: "assistant", message: { content: [{ type: "text", text: "TAB: x" }, { type: "tool_use" }] } },
    { type: "user", message: { content: [{ type: "tool_result" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "ELIR: y\n\nNo action needed on your end for this task." }] } },
  ];
  fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join("\n"));
  assert.equal(h.stop("a", undefined, { transcript_path: transcript }), null);
  fs.writeFileSync(transcript, lines.slice(0, 3).concat({ type: "assistant", message: { content: [{ type: "text", text: "plain" }] } }).map((l) => JSON.stringify(l)).join("\n"));
  assert.equal(h.stop("a", undefined, { transcript_path: transcript }).decision, "block");
});

test("session start injects the voice rules with the ON/OFF gate", () => {
  const h = harness();
  const ctx = h.run("SessionStart", { session_id: "a" }).hookSpecificOutput.additionalContext;
  assert.match(ctx, /only while the latest turn's context says `RDS voice: ON`/);
  assert.match(ctx, /## The Answer Gate/);
  assert.doesNotMatch(ctx, /^---/);
});

test("session end removes that session's state", () => {
  const h = harness();
  h.say("a", "RDS session off");
  h.run("SessionEnd", { session_id: "a" });
  assert.match(h.context("a", "hi"), /ON/);
});
