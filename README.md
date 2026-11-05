# RDS (Really Damn Simple)

A voice layer for Claude Code. Other skills decide what a reply says. Voice decides how it reads. It pairs with [mattpocock/skills](https://github.com/mattpocock/skills) and changes none of its files.

## Install

```
/plugin marketplace add AhmedHamid11/rds
/plugin install rds@rds
```

Install `mattpocock/skills` alongside it for the skills themselves.

## How it works

- `SessionStart` loads [the voice rules](skills/rds/SKILL.md) into context.
- `UserPromptSubmit` adds `RDS voice: ON` or `OFF` to each turn.
- `Stop` sends back a reply that misses the bold `ELIR:` line or a voice ending, once.
- Files that skills write (PR bodies, specs, ADRs) keep their own format.

## Switches

Voice is on by default. Use a slash command or type the words as the whole message. Neither reaches the model.

| Command | Words | Effect |
| --- | --- | --- |
| | `free` anywhere | Plain prose for that reply |
| `/rds:session-off`, `/rds:session-on` | `RDS session off` / `on` | This session only |
| `/rds:session-reset` | `RDS session reset` | This session follows global again |
| `/rds:global-off`, `/rds:global-on` | `RDS global off` / `on` | Every session, every project |
| `/rds:status` | `RDS status` | Shows the current setting and what set it |

Session beats global. State lives in `~/.claude/RDS/`.

## Test

```
node --test test/
```
