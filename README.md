# Hetzner Status Slack Bot

A simple bot that monitors [status.hetzner.com](https://status.hetzner.com) and posts new or updated incidents to a Slack channel via incoming webhook.

## How it works

1. Polls the Hetzner status page every 5 minutes (configurable)
2. Parses the embedded `__NEXT_DATA__` JSON to extract all incidents
3. Compares against the last known state to detect new or updated incidents
4. Posts formatted messages to Slack with incident details and direct links
5. Persists state to a JSON file so restarts don't re-notify

On first run, the bot loads all current incidents silently (no spam) and only notifies on changes from that point on.

### What gets tracked

- **Top Notifications** — critical alerts (outages, security warnings)
- **Information** — general notices (limited availability, system changes)
- **Maintenance** — planned maintenance windows
- **Incident History** — resolved incidents and their updates

## Setup

### 1. Create a Slack Incoming Webhook

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Enable **Incoming Webhooks** and add one to your desired channel
3. Copy the webhook URL

### 2. Configure

Copy `.env.example` to `.env` and set your values:

```sh
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `SLACK_WEBHOOK_URL` | Yes | — | Slack incoming webhook URL |
| `HETZNER_STATUS_LANG` | No | `en` | Language: `en` or `de` |
| `POLL_INTERVAL_SECONDS` | No | `300` | Poll interval (minimum 30s) |
| `STATE_FILE_PATH` | No | `./state.json` | Where to persist state |

### 3. Run

**With Docker Compose (recommended for production / Coolify):**

```sh
docker compose up -d
```

**Locally with Bun:**

```sh
bun run index.ts
```

## Debug Mode

To test that Slack integration works, post the N most recent active incidents and exit:

```sh
DEBUG_POST_LAST=3 bun run index.ts
```

## Deploy on Coolify

1. Create a new service from this repo (or paste the `docker-compose.yml`)
2. Set the `SLACK_WEBHOOK_URL` environment variable
3. Optionally set `HETZNER_STATUS_LANG` and `POLL_INTERVAL_SECONDS`
4. Deploy — the bot will start tracking immediately

## Tech Stack

- **Runtime:** [Bun](https://bun.sh)
- **Dependencies:** None (zero npm packages)
- **Docker:** `oven/bun:1-alpine`
