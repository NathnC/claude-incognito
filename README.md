# claude-incognito

**Incognito mode for Claude Code.** Type `/incognito` and the session stops writing memories, `CLAUDE.md` or notes. When it ends, its transcript, prompt history and per-session files are deleted.

## Install: paste this into Claude Code

```text
Install the claude-incognito plugin for me from https://github.com/NathnC/claude-incognito.
1. Run: claude plugin marketplace add NathnC/claude-incognito
2. Run: claude plugin install incognito@claude-incognito
3. Check Node.js is on my PATH (node --version). The plugin's hooks need it; tell me if it's missing.
4. Run: node "<install path>/scripts/incognito.mjs" cli setup
   <install path> is the newest folder under ~/.claude/plugins/cache/claude-incognito/incognito/.
5. That prints a claude-incognito launcher function. Add the version for my shell to my shell profile (skip it if one is already there).
6. Tell me to restart Claude Code, then summarise in two lines how to use /incognito and claude-incognito.
```

Or install by hand:

```bash
claude plugin marketplace add NathnC/claude-incognito
claude plugin install incognito@claude-incognito
# restart Claude Code, then run /incognito setup to add the launcher
```

## Use

| Command | What it does |
|---|---|
| `/incognito` | Turns incognito on for this session, from the point you run it. The whole session, including earlier turns, is deleted when it ends. |
| `/incognito status` | Shows whether incognito is on and what's still recording. |
| `/incognito off` | Turns it off. The session is then saved as normal. |
| `/incognito setup` | Adds the `claude-incognito` launcher to your shell profile. |
| `claude-incognito` | Starts a session that's incognito from the start, and also switches off other memory plugins and Claude Code auto-memory. Takes the same arguments as `claude`. |

## What it does

While incognito is on:

- **Blocks writes** (through a `PreToolUse` hook) to:
  - auto-memory (`~/.claude/projects/*/memory/`, `MEMORY.md`)
  - `CLAUDE.md` and `CLAUDE.local.md`
  - `.remember/` and `~/.claude/history.jsonl`
  - memory skills (`remember`, `harvest`, `revise-claude-md`, `claude-md-improver`, `import-memory`)
  - memory MCP tools (`mcp__*memory*` create, add, update and delete calls)

  Shell commands that write to those paths are blocked too. Reading them is still allowed.
- **Tells Claude** at the start of every turn not to keep notes, docs or summaries of the conversation.
- **When the session ends, deletes:**
  - the transcript `.jsonl` and the session's subagent and tool-result folder
  - `file-history`, `session-env`, debug logs and anything else under `~/.claude` named after the session id
  - the session's lines in `history.jsonl` (your up-arrow and ctrl+r history), plus any paste-cache entries only those lines used
- **Crash recovery:** if a session dies without a clean exit, the next session start cleans it up. It only does this once the session is no longer listed as running and its transcript hasn't been written to for 15 minutes.

Other sessions aren't affected. Incognito is tracked per session id.

## Limits

- **Other plugins' hooks keep running mid-session.** A plugin that records sessions (for example `remember`) still captures a session where you typed `/incognito`, and the plugin warns you when it finds one. Sessions started with `claude-incognito` disable those plugins via `--settings`. If you install another memory plugin later, re-run `/incognito setup`.
- **Local storage only.** Prompts are still sent to the model provider and fall under its retention policy. Incognito doesn't change that.
- **`/clear` starts a new session id.** The old session is deleted, but the new one isn't incognito unless you started with `claude-incognito` or run `/incognito` again.
- **The block list is a best effort.** Claude is told the rules and hooks enforce the obvious paths. A determined shell one-liner could still get past the command check. This is built to keep accidental saving out, not to stop someone trying hard.
- Needs Node.js on `PATH`. Claude Code installed through npm already has it.

## Config (optional)

Settings go in `~/.claude/incognito/config.json`:

```json
{
  "protectPaths": ["/notes/", "journal\\.md$"],
  "blockSkills": ["^my-notes-skill$"],
  "keepTranscript": false
}
```

- `protectPaths` adds extra path regexes to the write block list. Matching is case-insensitive and uses forward slashes.
- `blockSkills` adds extra skill-name regexes to block.
- `keepTranscript: true` keeps the write blocks but stops deleting the session at the end.

## Uninstall

```bash
claude plugin uninstall incognito@claude-incognito
claude plugin marketplace remove claude-incognito
```

Then remove the `claude-incognito` function from your shell profile and delete `~/.claude/incognito/`.

## License

MIT
