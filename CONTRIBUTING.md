# Contributing – Claude Code at Raptus

## Getting started

1. Clone the repo or use the template
2. Start `claude` in the project directory
3. `/help` shows available commands

## Available commands

- `/commit-push-pr` — automate the git workflow
- `/review` — code review of the current branch
- `/build-and-test` — run build and tests

## When Claude makes a mistake

1. **Correct it immediately.** Don't let it run through.
2. **Document the lesson:** Tell Claude: "Document this lesson in lessons.md"
3. **Note in the PR:** If it's a recurring issue, update CLAUDE.md or a rule

## Code review with Claude

On pull reviews you can tag `@.claude` (requires the Claude Code GitHub Action). Claude can then:
- Add errors to CLAUDE.md
- Add entries to lessons.md
- Directly suggest improvements

## Extending rules

If you need a new rule:
1. Create a `.md` file in `.claude/rules/`
2. Set `globs` in the frontmatter for the relevant file types
3. Keep the rule short and concrete
4. Create a PR

## Personal settings

For personal customisations: `.claude/settings.local.json` (git-ignored).
This file overrides team settings locally.

## Important

- **Keep CLAUDE.md lean.** Only what every session needs.
- **Rules for specifics.** Security, quality, a11y are separate.
- **Hooks for determinism.** What always must happen (formatting) belongs in hooks.
- **Maintain lessons.md.** Every documented error saves the team time.
