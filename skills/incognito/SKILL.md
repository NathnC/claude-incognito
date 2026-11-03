---
name: incognito
description: Incognito mode for this Claude Code session. Blocks memory, CLAUDE.md and notes writes, and deletes the session's transcript, prompt history and per-session files when it ends. Use when the user types /incognito [on|off|status|setup], or asks to go incognito, off the record, private mode, "don't remember this" or "don't save anything from this session".
argument-hint: "[on|off|status|setup]"
allowed-tools: Bash(node:*)
---

# Incognito

Run this exactly once, then act on its output. Leave the argument blank to turn incognito on:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/incognito.mjs" cli "${CLAUDE_SESSION_ID}" $ARGUMENTS
```

- **on** (default) / **status**: give the user the script's status line(s) as they are, in one short reply. Pass on any ⚠ line about recorder plugins.
- **off**: confirm incognito is off and that this session will now be saved normally.
- **setup**: the script prints a launcher function for bash/zsh, PowerShell and fish. Detect the user's shell, then append the matching function to their profile file (`~/.bashrc`, `~/.zshrc`, `$PROFILE` or `~/.config/fish/config.fish`). Skip this if a `claude-incognito` function is already there. Tell them to open a new terminal and use `claude-incognito` in place of `claude` whenever they want a fully private session.

## While incognito is on

Follow these until the user runs `/incognito off`. The plugin's hooks repeat them every turn.

- Don't create, update or delete memory: auto-memory files, `MEMORY.md`, memory MCP tools, or memory skills/plugins.
- Don't edit `CLAUDE.md` / `CLAUDE.local.md`, and don't write notes, logs, journals, reports, docs or summaries that record this conversation or facts about the user.
- Don't publish artifacts or docs, or send anything out, unless the user asks for it in this session.
- Work the user asks for (code edits, files they name, commands) is fine.
- If a hook blocks a tool call because of incognito, don't retry or work around it. Tell the user it was blocked and that `/incognito off` lifts the block.
- Be accurate about what is kept. The transcript stays on disk until the session ends and is then deleted. Other plugins' hooks can still record unless the session was started with `claude-incognito`. Requests already sent to the model provider follow the provider's own retention policy; incognito is about local storage only.
