# Contributing

## How to ship a change

The whole shipping process is **one mental step: open a PR and merge it.** Everything else runs automatically.

1. Make changes on a branch.
   ```bash
   git checkout -b my-change
   # edit, commit
   git push -u origin my-change
   ```
2. Open a Pull Request. The `git push` output prints the exact URL — just click it. Or in the GitHub UI: **Pull requests → New pull request → Compare → Create pull request**.
3. CI runs on the PR (build, lint, tests). Wait until it's green.
4. Click **Merge pull request → Confirm merge**.

That's it. After the merge:

- GitHub Actions rebuilds the Docker image (`.github/workflows/image.yml`).
- The image is pushed to GHCR as `ghcr.io/gzuercher/status-page-to-chat:latest` (and tagged with the merge commit's short SHA).
- In Portainer, click **Update the stack** with re-pull enabled — the new image is now live.

You do not need to tag anything, run any CLI commands, or remember release procedures. The PR merge IS the release.

## Where things happen

| What | Where |
|---|---|
| CI status (build, lint, tests) | the PR page itself, or **GitHub → Actions** |
| Image build status | **GitHub → Actions → "Build and publish image"** |
| Published images | **GitHub → Packages** (or `https://github.com/users/gzuercher/packages/container/status-page-to-chat`) |
| Logs of running container | Portainer → Containers → `status-page-to-chat` → Logs |

## When something is wrong

- **CI red on the PR**: open the PR's Checks tab → click into the failing step. Fix locally, push again — the PR auto-updates.
- **Image build red on main** (after merge): the Dockerfile broke. Check the Actions log for the failing step. The previous image stays on GHCR and is still pullable, so the production container is unaffected until you pull.
- **Container won't start in Portainer**: check the container's Logs view. Usually `WEBHOOK_URL` not set or providers.yaml invalid — the log says which.

## Local development

```bash
pnpm install
pnpm build
pnpm test
WEBHOOK_URL='https://webhook.site/<your-slot>' STATE_DB_PATH=./data/state.sqlite pnpm start
```

For container-level testing (matches what GHCR will run):

```bash
echo "WEBHOOK_URL=https://webhook.site/<your-slot>" > .env
docker compose up --build
```

## When Claude Code makes a mistake

1. Correct it immediately.
2. Ask Claude: "document this lesson in `lessons.md`" — the file has a one-line-per-lesson format with the date.
3. If it's a recurring class of error, add a rule in `.claude/rules/` or update `CLAUDE.md`.
