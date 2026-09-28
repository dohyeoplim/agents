<h3 align="center">
    dohyeoplim/agents
</h3>

<hr />

### Features

- Persistent conversations, memory, scheduled tasks, and daily briefings.
- Slack message search, Canvas editing, and universal document workflows.
- Deep research with independent Codex and Claude reports, Slack controls, and Canvas export.

#### Integrations

- OpenAI Codex
- Claude Code
- Slack API
- Notion MCP
- Google Calendar API
- Apple WeatherKit
- arXiv

### Usage

#### Setup

```sh
cp .env.example .env
cp config/routes.example.json config/routes.json
mkdir -p data/gateway data/secrets data/assistant/codex data/assistant/workspace
```

- Slack app generated using `slack-manifest.json`.
- `.env`: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` (`connections:write`), and `POSTGRES_PASSWORD`.
- `config/routes.json`: workspace, user, and channel IDs.

#### Build

```sh
docker compose build --pull --no-cache
```

#### Authentication

- Codex: `docker compose run --rm assistant codex login --device-auth`
- Claude: `docker compose run --rm assistant claude auth login`
- Notion: `docker compose run --rm assistant npm run integrations -- notion-login`

#### Optional integrations

- Google Calendar with an OAuth Desktop client

  ```sh
  npm ci
  npm run integrations -- google-login /path/to/client.json
  ```

- WeatherKit: enable the service and place the `.p8` key and `weatherkit.json` in `data/secrets`.
  JSON fields: `teamId`, `keyId`, `serviceId`, `keyFile`.
- Briefing settings: `config/.private/personal.json`.

#### Run

```sh
docker compose up -d --build
```

