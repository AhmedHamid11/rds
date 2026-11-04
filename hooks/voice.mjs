import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "RDS";
const HOME = process.env.RDS_HOME ?? path.join(os.homedir(), ".claude", NAME);
const GLOBAL_FILE = path.join(HOME, "global");
const SESSIONS_DIR = path.join(HOME, "sessions");
const SKILL_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "rds", "SKILL.md");

const PREFIX = `(?:${NAME}\\s+|/${NAME}:)`;
const SWITCH = new RegExp(`^\\s*${PREFIX}(session|global)[\\s-]+(on|off|reset)\\s*$`, "i");
const STATUS = new RegExp(`^\\s*${PREFIX}status\\s*$`, "i");
const FREE = /\bfree\b/i;
const ENDINGS = ["No action needed on your end for this task.", "(silence = 1)"];

const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
};

const sessionFile = (id) => path.join(SESSIONS_DIR, `${String(id).replace(/[^A-Za-z0-9_-]/g, "")}.json`);

const readSession = (id) => {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(id), "utf8"));
  } catch {
    return { override: null, turn: "on" };
  }
};

const writeSession = (id, session) => {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(sessionFile(id), JSON.stringify(session));
};

const globalSetting = () => (readText(GLOBAL_FILE) === "off" ? "off" : "on");

const resolve = ({ free, override, global }) => {
  if (free) return { state: "off", by: "reply (free)" };
  if (override) return { state: override, by: "session" };
  return { state: global, by: global === "off" ? "global" : "default" };
};

const emit = (obj) => process.stdout.write(JSON.stringify(obj));

const finalReply = (input) => {
  if (typeof input.last_assistant_message === "string") return input.last_assistant_message;
  const lines = (readText(input.transcript_path) ?? "").split("\n").filter(Boolean);
  const texts = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry.message?.content;
    if (entry.type === "user") {
      const isPrompt = typeof content === "string" || content?.some?.((b) => b.type === "text");
      if (isPrompt && !entry.isMeta) texts.length = 0;
    } else if (entry.type === "assistant" && Array.isArray(content)) {
      for (const b of content) if (b.type === "text") texts.push(b.text);
    }
  }
  return texts.join("\n");
};

const voiceFailures = (reply) => {
  const text = reply.trim();
  const failures = [];
  if (!text.startsWith("TAB:")) failures.push("first line is not `TAB:`");
  if (!/^ELIR:/m.test(text)) failures.push("no `ELIR:` line");
  if (!ENDINGS.some((e) => text.endsWith(e))) failures.push("ending is neither the no-action line nor the banner");
  return failures;
};

const handlers = {
  SessionStart() {
    const skill = readText(SKILL_FILE)?.replace(/^---[\s\S]*?---\s*/, "");
    if (!skill) return;
    emit({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `Obey the voice contract below only while the latest turn's context says \`${NAME} voice: ON\`. When it says OFF, write plainly.\n\n${skill}`,
      },
    });
  },

  UserPromptSubmit(input) {
    const prompt = input.prompt ?? "";
    const session = readSession(input.session_id);
    const sw = prompt.match(SWITCH);
    if (sw) {
      const [scope, action] = [sw[1].toLowerCase(), sw[2].toLowerCase()];
      if (scope === "session") {
        writeSession(input.session_id, { ...session, override: action === "reset" ? null : action });
      } else if (action === "off") {
        fs.mkdirSync(HOME, { recursive: true });
        fs.writeFileSync(GLOBAL_FILE, "off");
      } else {
        fs.rmSync(GLOBAL_FILE, { force: true });
      }
    }
    if (sw || STATUS.test(prompt)) {
      const now = resolve({ free: false, override: readSession(input.session_id).override, global: globalSetting() });
      emit({ decision: "block", reason: `${NAME} voice: ${now.state.toUpperCase()} (set by ${now.by}). Global: ${globalSetting()}.` });
      return;
    }
    const now = resolve({ free: FREE.test(prompt), override: session.override, global: globalSetting() });
    writeSession(input.session_id, { ...session, turn: now.state });
    emit({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `${NAME} voice: ${now.state.toUpperCase()} (set by ${now.by})`,
      },
    });
  },

  Stop(input) {
    if (input.stop_hook_active || readSession(input.session_id).turn !== "on") return;
    const failures = voiceFailures(finalReply(input));
    if (failures.length === 0) return;
    emit({ decision: "block", reason: `Rewrite your last reply in the voice contract: ${failures.join("; ")}.` });
  },

  SessionEnd(input) {
    fs.rmSync(sessionFile(input.session_id), { force: true });
  },
};

const raw = fs.readFileSync(0, "utf8");
handlers[process.argv[2]]?.(raw ? JSON.parse(raw) : {});
