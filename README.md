<h3 align="center">
    dohyeoplim/agents
</h3>

<hr />

#### Setup

```sh
cp .env.example .env
cp config/routes.example.json config/routes.json
mkdir -p data/gateway data/secrets data/assistant/codex data/assistant/workspace
```

- Slack app generated from `slack-manifest.json`.
- `.env`: `SLACK_BOT_TOKEN` (`xoxb-...`), `SLACK_APP_TOKEN` (`xapp-...`, `connections:write`).
- `config/routes.json`: workspace, user, and channel IDs.

#### Build

```sh
docker compose build --pull --no-cache
```

#### Codex login

```sh
docker compose run --rm assistant codex login --device-auth
```

#### Optional integrations

- Google Calendar API (with OAuth Desktop client)

  ```sh
  npm ci
  npm run integrations -- google-login /path/to/client.json
  ```

- WeatherKit enabled, `.p8` key and `weatherkit.json` in `data/secrets`.
  JSON fields: `teamId`, `keyId`, `serviceId`, `keyFile`.
- Briefing settings: `config/.private/personal.json`.

#### Run

```sh
docker compose up -d
```
