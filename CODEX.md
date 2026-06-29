# Codex Context

## Project

`atp-mqtt` fetches ATP-family and men's Grand Slam match rows from the public Kambi/Svenska Spel tennis feed and publishes display-friendly live tennis state to MQTT.

This service is standalone and does not depend on `atp-tennis`, `vitel`, `tennis.egelberg.se`, or the MariaDB-backed ATP database. It exists for display-style consumers such as MQTT/Homey/Cosmic Unicorn flows.

## Repository

- Local path: `/Users/magnus/Documents/GitHub/atp-mqtt`
- GitHub repository: `meg768/atp-mqtt`
- Runtime entrypoint: `run.js`
- Environment example: `.env.example`
- Node requirement from `package.json`: `>=18`

## Run

Install dependencies:

```bash
npm install
```

Fetch once:

```bash
npm run fetch
node run.js
```

Publish once:

```bash
npm run publish
node run.js --publish
```

Run continuous polling publisher:

```bash
npm run publish:poll
node run.js --publish --poll
```

Syntax check:

```bash
node --check run.js
```

There is no test suite at the time this context was written.

## Configuration

Environment variables:

- `MQTT_URL`: broker URL
- `MQTT_TOPIC`: exact topic prefix, default `atp`
- `MQTT_TOPIC_PREFIX`: legacy/alternate topic-prefix input; `MQTT_TOPIC` wins
- `MQTT_USERNAME`
- `MQTT_PASSWORD`
- `MQTT_CLIENT_ID`: default `atp-mqtt-<hostname>-<pid>`
- `MQTT_RETAIN`: defaults to `true`
- `ODDSET_API_URL`: upstream Kambi/Svenska Spel feed override
- `ATP_MQTT_MAX_LIVE`: selected live cap, default `3`
- `ATP_MQTT_MAX_UPCOMING`: selected upcoming cap, default `3`
- `ATP_MQTT_LIVE_POLL_SECONDS`: default `30`
- `ATP_MQTT_IDLE_POLL_SECONDS`: default `1800`

Do not commit `.env`.

## Data Source And Filtering

Default upstream:

```text
https://eu1.offering-api.kambicdn.com/offering/v2018/svenskaspel/listView/tennis/all/all/all/matches.json
```

`run.js` adds required query parameters: `channel_id=1`, `client_id=200`, `lang=sv_SE`, `market=SE`, `useCombined=true`, and `useCombinedLive=true`.

The broad `/tennis/all` source is intentional because Grand Slam events may be missing from `/tennis/atp`.

Inclusion/filtering rules:

- include `atp` and `grand_slam` path terms
- exclude WTA, Challenger, UTR, qualifiers/kval, women's/damer, and doubles/dubbel
- use only Kambi states `STARTED` and `NOT_STARTED`

## MQTT Contract

With `MQTT_TOPIC=atp`, published topics are:

- `atp`: full JSON snapshot
- `atp/scoreboard`: rotating live scoreboard text
- `atp/scoreboard/A`: fixed slot A
- `atp/scoreboard/B`: fixed slot B
- `atp/scoreboard/C`: fixed slot C
- `atp/upcoming`: upcoming-match text

The full snapshot contains:

- `timestamp`
- `headline`
- `totals`
- `nextMatch`
- `metadata`
- `sections.live.items`
- `sections.upcoming.items`

The root `atp` topic is JSON. Scoreboard and upcoming topics are plain text.

## Scoreboard Behavior

- Live matches are selected by importance, with Grand Slam > ATP, plus boosts for Masters/1000 and late-round text when exposed.
- Court-aware priority tries to map major courts into slots A/B/C.
- Numbered courts get priority where lower court numbers sort before higher numbers.
- Slots stay sticky while a match remains live.
- Empty slots publish `Ingen pågående match` so retained stale values are cleared.
- `atp/scoreboard` rotates toward changed matches and avoids repeating the same changed match if another changed match is available.

## Deployment Notes

2026-06-30: Production runs on `pi-kato` under root PM2:

```text
name: atp-mqtt
cwd: /home/pi/atp-mqtt
script: /home/pi/atp-mqtt/run.js
args: --publish --poll
status: online
```

The server checkout and local checkout were both at commit `2935d5d Generalize scoreboard court priority` when checked.

Recent PM2 logs showed live Wimbledon rows and "score unchanged; skipping MQTT publish" behavior working. Older error logs included transient upstream curl failures, MQTT connection refusal, and DNS lookup failures for `router.egelberg.se`; treat those as operational signals to check broker/network/upstream health before changing code.

Useful commands:

```bash
ssh pi@pi-kato 'sudo -n pm2 logs atp-mqtt --lines 80 --nostream'
ssh pi@pi-kato 'sudo -n pm2 restart atp-mqtt'
ssh pi@pi-kato 'cd /home/pi/atp-mqtt && git pull --ff-only origin main'
```

## Gotchas

- Global `codex-chat/CONTEXT.md` has older notes that mention topics such as `atp/summary` and `atp/live`; current code publishes the scoreboard topics listed above.
- This service uses betting/offering feed data, not canonical ATP API data.
- `requestJson()` falls back to `curl` when built-in `fetch` fails or is unavailable.
- CLI/table output and MQTT display text are Swedish-oriented by design.
- The score signature includes selected live scores and selected upcoming starts; changes outside the selected set may not trigger a publish.
