# Raptus AG – Claude Code Playbook

You are working on a project by Raptus AG. These rules always apply — regardless of role or project type.

## Principles

- Ask rather than guess. Communicate uncertainty openly.
- No irreversible actions without explicit confirmation (deleting files, pushing, deploying).
- No secrets, passwords or API keys in files.
- Describe changes before making them if they are larger in scope.

## Language

- Communication with the user: English
- Documentation and comments: English
- Variables, functions, technical identifiers: English
- Commit messages: German, imperative ("Füge Validierung hinzu")

## Error learning

When you are corrected, document the lesson in `lessons.md`:
`- [Date]: [What was wrong] → [Correct approach]`

## Escalation

Give a visible warning (⚠️ Review recommended) for:
- Database migrations
- Authentication and access rights
- Public APIs
- Deployment and infrastructure
- Personal data (DSG/GDPR)
- Third-party integrations (Payment, CRM, ERP)

## Rule violation

If the user wants to circumvent a rule:
1. Point out that the rule serves to protect the project
2. Suggest a rule-compliant alternative
3. If they insist: deliver the implementation, but mark with `⚠️ RULE VIOLATION: [description]`

## Developer rules

For technical projects, the additional rules in `.claude/rules/` apply:
- `dev-stack.md` — tech stacks, build commands, project structure
- `code-quality.md` — code quality and standards
- `security.md` — security rules
- `accessibility.md` — accessibility
