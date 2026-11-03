#!/usr/bin/env node
// claude-incognito — one script for every hook event plus the /incognito CLI.
//
//   node incognito.mjs hook                      (stdin: Claude Code hook JSON)
//   node incognito.mjs cli <session-id> [on|off|status|setup]
//   node incognito.mjs purge <session-id> [--delay ms]
//   node incognito.mjs sweep
//
// State: <config>/incognito/sessions/<session-id>.json marks a session as incognito.
// Nothing about the conversation itself is ever written by this script.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'incognito');
const MARK_DIR = path.join(STATE_DIR, 'sessions');
const USER_CONFIG = path.join(STATE_DIR, 'config.json');
const LAUNCHER_SETTINGS = path.join(STATE_DIR, 'launcher-settings.json');
const SELF = fileURLToPath(import.meta.url);
const SID_RE = /^[A-Za-z0-9_-]{8,128}$/;

// Plugins that record sessions through their own hooks. Incognito can't stop another
// plugin's hooks mid-session, so it warns about these and the launcher disables them.
const RECORDER_RE = /(remember|memory|memories|recall|journal|mem0|supermemory|claude-mem|history|diary)/i;

const RULES = `INCOGNITO MODE IS ON for this session (claude-incognito plugin). Until the user turns it off:
- Do NOT create, update or delete any memory: auto-memory files, MEMORY.md, memory MCP tools, or memory plugins/skills (remember, harvest, revise-claude-md, import-memory...).
- Do NOT edit CLAUDE.md / CLAUDE.local.md, and do not write notes, logs, journals, reports, changelogs, docs or summaries that record this conversation, its decisions, or facts about the user.
- Do NOT publish artifacts/docs or send anything externally unless the user explicitly asks in this session.
- Work the user explicitly asks for (code edits, files they name, commands) is fine.
- Don't mention this session in anything durable unless asked (e.g. a commit message the user requests is fine).
- If asked what is being kept: the transcript exists on disk until the session ends, then the plugin deletes it plus its prompt-history lines and per-session files. Other plugins' hooks may still record, unless the session was started with the claude-incognito launcher.
The user turns this off with "/incognito off" (the session is then KEPT as normal).`;

// ---------------------------------------------------------------------------- utils
const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
const readJSON = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const markerPath = (sid) => path.join(MARK_DIR, `${sid}.json`);
const isOn = (sid) => !!sid && SID_RE.test(sid) && fs.existsSync(markerPath(sid));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setOn(sid, extra = {}) {
  if (!SID_RE.test(sid)) throw new Error(`bad session id: ${sid}`);
  fs.mkdirSync(MARK_DIR, { recursive: true });
  const prev = readJSON(markerPath(sid), {});
  fs.writeFileSync(markerPath(sid), JSON.stringify({ since: prev.since || Date.now(), ...prev, ...extra }));
}
function setOff(sid) { try { fs.unlinkSync(markerPath(sid)); } catch {} }

function userConfig() {
  const c = readJSON(USER_CONFIG, {}) || {};
  return {
    protectPaths: (c.protectPaths || []).map((s) => new RegExp(s, 'i')),
    blockSkills: (c.blockSkills || []).map((s) => new RegExp(s, 'i')),
    keepTranscript: !!c.keepTranscript,
  };
}

function recorderPlugins() {
  const installed = readJSON(path.join(CONFIG_DIR, 'plugins', 'installed_plugins.json'), {}) || {};
  const ids = Object.keys(installed.plugins || installed || {});
  const enabled = (readJSON(path.join(CONFIG_DIR, 'settings.json'), {}) || {}).enabledPlugins || {};
  return ids.filter((id) => RECORDER_RE.test(id.split('@')[0]) && enabled[id] !== false && !/^incognito@/.test(id));
}

function out(obj) { process.stdout.write(JSON.stringify(obj)); }

// ---------------------------------------------------------------------------- guard
const PROTECTED = [
  /\/\.claude\/projects\/[^/]+\/memory(\/|$)/, // auto-memory
  /(^|\/)memory\.md$/,
  /(^|\/)claude(\.local)?\.md$/,
  /(^|\/)\.remember(\/|$)/,
  /\/\.claude\/history\.jsonl$/,
];
const PROTECTED_IN_CMD = [
  /\.claude\/projects\/[^\s'"]+\/memory\b/,
  /\bmemory\.md\b/,
  /\bclaude(\.local)?\.md\b/,
  /(^|[\s'"/])\.remember\//,
];
const WRITEY = /(>|\btee\b|\bsed\s+-[a-z]*i|\bperl\s+-[a-z]*i|\bcp\b|\bmv\b|\brm\b|\btouch\b|\bln\b|set-content|add-content|out-file|new-item|remove-item|copy-item|move-item|rename-item|writefile|appendfile|\bgit\s+(add|commit|rm|mv)\b)/;
const BLOCK_SKILLS = /(^|:)(remember|harvest|revise-claude-md|claude-md-improver|import-memory)$/i;
const MCP_MEMORY = /^mcp__.*(memory|memories|remember|mem0|knowledge[-_]?graph)/i;
const MCP_WRITEY = /(create|add|write|save|store|update|upsert|delete|remove|insert|put|set|append|observ|relation|entit)/i;

function guard(input) {
  const name = input.tool_name || '';
  const ti = input.tool_input || {};
  const cfg = userConfig();
  const pathHit = (p) => { const n = norm(p); return PROTECTED.some((r) => r.test(n)) || cfg.protectPaths.some((r) => r.test(n)); };

  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) {
    const p = ti.file_path || ti.notebook_path || ti.path;
    if (p && pathHit(p)) return `writes to ${p} (memory / CLAUDE.md / history)`;
  } else if (/^(Bash|PowerShell)$/.test(name)) {
    const c = norm(ti.command);
    if ((PROTECTED_IN_CMD.some((r) => r.test(c)) || cfg.protectPaths.some((r) => r.test(c))) && WRITEY.test(c))
      return 'a shell command that writes to memory / CLAUDE.md / history files';
  } else if (name === 'Skill') {
    const s = String(ti.skill || ti.name || '');
    if (BLOCK_SKILLS.test(s) || cfg.blockSkills.some((r) => r.test(s))) return `the memory-saving skill "${s}"`;
  } else if (MCP_MEMORY.test(name) && MCP_WRITEY.test(name.split('__').pop())) {
    return `the memory tool ${name}`;
  }
  return null;
}

// ---------------------------------------------------------------------------- purge
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); return !fs.existsSync(p); } catch { return false; } }

function purgeOnce(sid) {
  let removed = 0, failed = 0;
  const hit = (p) => (rm(p) ? removed++ : failed++);
  // 1. Anything named after the session id: transcripts + per-session dirs (subagents,
  //    tool results) under projects/*, and file-history, session-env, debug, todos,
  //    security, tasks... at the top level of the config dir.
  const scan = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
  for (const e of scan(CONFIG_DIR)) {
    if (['plugins', 'incognito'].includes(e.name)) continue;
    const full = path.join(CONFIG_DIR, e.name);
    if (e.name.includes(sid)) { hit(full); continue; }
    if (!e.isDirectory()) continue;
    for (const f of scan(full)) {
      const p2 = path.join(full, f.name);
      if (f.name.includes(sid)) hit(p2);
      else if (e.name === 'projects' && f.isDirectory())
        for (const g of scan(p2)) if (g.name.includes(sid)) hit(path.join(p2, g.name));
    }
  }
  // 2. Prompt history (up-arrow / ctrl+r): drop this session's lines + any paste-cache blobs
  //    only they referenced.
  const hist = path.join(CONFIG_DIR, 'history.jsonl');
  try {
    const lines = fs.readFileSync(hist, 'utf8').split('\n');
    const needle = `"sessionId":"${sid}"`;
    const drop = lines.filter((l) => l.includes(needle));
    if (drop.length) {
      const keep = lines.filter((l) => !l.includes(needle));
      fs.writeFileSync(hist, keep.join('\n'));
      removed += drop.length;
      const hashes = new Set();
      for (const l of drop) for (const m of l.matchAll(/"contentHash":"([^"]+)"/g)) hashes.add(m[1]);
      const keptText = keep.join('\n');
      const pc = path.join(CONFIG_DIR, 'paste-cache');
      for (const h of hashes) if (!keptText.includes(h)) for (const f of scan(pc)) if (f.name.startsWith(h)) hit(path.join(pc, f.name));
    }
  } catch {}
  return { removed, failed };
}

async function purge(sid, delay = 0) {
  if (!SID_RE.test(sid)) return;
  if (delay) await sleep(delay);
  let r = purgeOnce(sid);
  // Claude Code may still hold the transcript open while it exits (Windows locks it).
  for (let i = 0; i < 8 && r.failed; i++) { await sleep(1500); r = purgeOnce(sid); }
  if (!r.failed) setOff(sid);
  return r;
}

function findTranscript(sid) {
  const pd = path.join(CONFIG_DIR, 'projects');
  try { for (const d of fs.readdirSync(pd)) { const p = path.join(pd, d, `${sid}.jsonl`); if (fs.existsSync(p)) return p; } } catch {}
  return null;
}

function liveSessionIds() {
  const ids = new Set();
  const dir = path.join(CONFIG_DIR, 'sessions');
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) { const j = readJSON(path.join(dir, f)); if (j?.sessionId) ids.add(j.sessionId); } } catch {}
  return ids;
}

// Purge incognito sessions that ended without a clean SessionEnd (crash, killed terminal).
async function sweep(exceptSid) {
  let files = [];
  try { files = fs.readdirSync(MARK_DIR).filter((f) => f.endsWith('.json')); } catch { return; }
  if (!files.length) return;
  const live = liveSessionIds();
  for (const f of files) {
    const sid = f.slice(0, -5);
    if (sid === exceptSid || live.has(sid)) continue;
    const m = readJSON(path.join(MARK_DIR, f), {}) || {};
    if (Date.now() - (m.since || 0) < 60_000) continue;
    if (m.keep) { setOff(sid); continue; }
    // Belt and braces: never purge a transcript that is still being written to.
    const t = m.transcript || findTranscript(sid);
    try { if (t && Date.now() - fs.statSync(t).mtimeMs < 15 * 60_000) continue; } catch {}
    await purge(sid);
  }
}

function spawnDetached(args) {
  try { spawn(process.execPath, [SELF, ...args], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}

// ---------------------------------------------------------------------------- messages
function statusText(sid) {
  const on = isOn(sid);
  const rec = recorderPlugins();
  const launched = process.env.CLAUDE_INCOGNITO_LAUNCHER === '1';
  const keep = userConfig().keepTranscript;
  let s = on
    ? `🕶  Incognito ON. Memory writes are blocked and ${keep ? 'the transcript is KEPT (keepTranscript=true)' : 'this session\'s transcript, prompt history and per-session files are deleted when it ends'}.`
    : '👁  Incognito OFF. This session is saved as normal.';
  if (on && rec.length && !launched)
    s += `\n⚠  These plugins record sessions with their own hooks and are still running: ${rec.join(', ')}. To leave them out, start sessions with the \`claude-incognito\` launcher (run "/incognito setup").`;
  if (on && process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== '1')
    s += '\nℹ  Claude Code auto-memory is still loaded (read-only now); the launcher turns it off entirely.';
  return s;
}

function setup() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const rec = recorderPlugins();
  const settings = { enabledPlugins: Object.fromEntries(rec.map((id) => [id, false])), autoMemoryEnabled: false };
  fs.writeFileSync(LAUNCHER_SETTINGS, JSON.stringify(settings, null, 2));
  const sp = LAUNCHER_SETTINGS.replace(/\\/g, '/');
  return `Wrote ${sp}
Recorder plugins the launcher disables: ${rec.length ? rec.join(', ') : '(none found)'}

Add ONE of these to the user's shell profile (re-run "/incognito setup" after installing new memory plugins):

# bash / zsh  (~/.bashrc or ~/.zshrc)
claude-incognito() { CLAUDE_INCOGNITO=1 CLAUDE_INCOGNITO_LAUNCHER=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude --settings "${sp}" "$@"; }

# PowerShell  ($PROFILE)
function claude-incognito { $o=@($env:CLAUDE_INCOGNITO,$env:CLAUDE_INCOGNITO_LAUNCHER,$env:CLAUDE_CODE_DISABLE_AUTO_MEMORY); $env:CLAUDE_INCOGNITO='1'; $env:CLAUDE_INCOGNITO_LAUNCHER='1'; $env:CLAUDE_CODE_DISABLE_AUTO_MEMORY='1'; try { claude --settings "${sp}" @args } finally { $env:CLAUDE_INCOGNITO,$env:CLAUDE_INCOGNITO_LAUNCHER,$env:CLAUDE_CODE_DISABLE_AUTO_MEMORY=$o } }

# fish  (~/.config/fish/config.fish)
function claude-incognito; env CLAUDE_INCOGNITO=1 CLAUDE_INCOGNITO_LAUNCHER=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude --settings "${sp}" $argv; end`;
}

// ---------------------------------------------------------------------------- hook
const CMD_RE = /^\s*\/(?:incognito:|claude-incognito:)?incognito(?:\s+(on|off|status|setup))?\s*$/i;

async function hook(input) {
  const ev = input.hook_event_name;
  const sid = input.session_id;
  const envOn = process.env.CLAUDE_INCOGNITO === '1';

  if (ev === 'SessionStart') {
    if (envOn) setOn(sid, { transcript: input.transcript_path });
    spawnDetached(['sweep', sid]);
    if (isOn(sid)) out({ systemMessage: statusText(sid), hookSpecificOutput: { hookEventName: ev, additionalContext: RULES } });
    return;
  }
  if (ev === 'UserPromptSubmit') {
    const m = CMD_RE.exec(input.prompt || '');
    if (m) {
      const a = (m[1] || 'on').toLowerCase();
      if (a === 'on') setOn(sid, { transcript: input.transcript_path });
      if (a === 'off') setOff(sid);
      if (a === 'setup') return; // the skill handles it
      out({ systemMessage: statusText(sid), hookSpecificOutput: { hookEventName: ev, additionalContext: isOn(sid) ? RULES : 'Incognito mode is now OFF; the session is saved as normal.' } });
      return;
    }
    if (isOn(sid)) out({ hookSpecificOutput: { hookEventName: ev, additionalContext: 'Reminder: INCOGNITO MODE is ON. Save nothing durable (no memory, CLAUDE.md, notes or docs about this session) unless the user explicitly asks for that exact write.' } });
    return;
  }
  if (ev === 'PreToolUse') {
    if (!isOn(sid)) return;
    const why = guard(input);
    if (why) out({ hookSpecificOutput: { hookEventName: ev, permissionDecision: 'deny', permissionDecisionReason: `Incognito mode is ON, so ${why} is blocked. Don't retry or work around it. If the user explicitly wants this saved, they need to run "/incognito off" first.` } });
    return;
  }
  if (ev === 'SessionEnd') {
    if (!isOn(sid)) return;
    const m = readJSON(markerPath(sid), {}) || {};
    if (userConfig().keepTranscript || m.keep) { setOff(sid); return; }
    // A clean exit purges now, then a detached pass catches whatever Claude Code flushes
    // or still has locked as it exits.
    purgeOnce(sid);
    spawnDetached(['purge', sid, '--delay', '2500']);
  }
}

// ---------------------------------------------------------------------------- main
const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'hook') {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    let input = {};
    try { input = JSON.parse(raw); } catch {}
    await hook(input);
  } else if (cmd === 'cli') {
    const [sid, action = 'on'] = args;
    const a = action.toLowerCase();
    if (a === 'setup' || sid === 'setup') console.log(setup());
    else {
      if (!SID_RE.test(sid || '')) throw new Error('missing session id');
      if (a === 'on') setOn(sid);
      else if (a === 'off') setOff(sid);
      else if (a !== 'status') throw new Error(`unknown action "${action}" (use on|off|status|setup)`);
      console.log(statusText(sid));
    }
  } else if (cmd === 'purge') {
    const i = args.indexOf('--delay');
    const r = await purge(args[0], i >= 0 ? Number(args[i + 1]) : 0);
    if (process.stdout.isTTY && r) console.log(`removed ${r.removed}, failed ${r.failed}`);
  } else if (cmd === 'sweep') {
    await sweep(args[0]);
  } else {
    console.log('usage: incognito.mjs hook | cli <session-id> [on|off|status|setup] | purge <session-id> | sweep');
  }
} catch (e) {
  // Hooks must never break the session. Fail quietly on hook paths, loudly on the CLI.
  if (cmd === 'cli') { console.error(`incognito: ${e.message}`); process.exit(1); }
}
