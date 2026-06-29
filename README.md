# atp-mqtt

Node.js service that fetches ATP and men's Grand Slam match data from the public Kambi/Svenska Spel tennis feed and publishes a compact live tennis snapshot to MQTT.

The service is standalone. It does not depend on `tennis.egelberg.se`, `atp-tennis`, or the MariaDB-backed ATP API.

## What It Publishes

The project is tuned for display-style consumers:

- a full JSON snapshot
- one rotating scoreboard text
- three fixed scoreboard slot texts
- one upcoming-match text

It fetches the broad tennis feed because Grand Slam rows are not always exposed under the narrower ATP feed, then filters down to ATP-family and men's Grand Slam matches. Obvious WTA, Challenger, UTR, qualifier, women's, and doubles rows are excluded.

## Requirements

- Node.js 18+
- npm
- MQTT broker, when publishing

## Install

```bash
npm install
```

## Configure

Copy `.env.example` to `.env` and adjust values:

```env
MQTT_URL=mqtt://127.0.0.1:1883
MQTT_TOPIC=atp
MQTT_USERNAME=
MQTT_PASSWORD=
```

Optional environment variables:

- `MQTT_TOPIC_PREFIX`: alternate topic-prefix input; `MQTT_TOPIC` wins
- `MQTT_CLIENT_ID`: default `atp-mqtt-<hostname>-<pid>`
- `MQTT_RETAIN`: defaults to `true`
- `ODDSET_API_URL`: override the upstream Kambi/Svenska Spel URL
- `ATP_MQTT_MAX_LIVE`: default `3`
- `ATP_MQTT_MAX_UPCOMING`: default `3`
- `ATP_MQTT_LIVE_POLL_SECONDS`: default `30`
- `ATP_MQTT_IDLE_POLL_SECONDS`: default `1800`

## Run

Fetch once and print a local table:

```bash
npm run fetch
```

or:

```bash
node run.js
```

Publish once to MQTT:

```bash
npm run publish
```

Run continuously and publish when the selected match state changes:

```bash
npm run publish:poll
```

or:

```bash
node run.js --publish --poll
```

## MQTT Topics

With `MQTT_TOPIC=atp`, the service publishes:

- `atp`
- `atp/scoreboard`
- `atp/scoreboard/A`
- `atp/scoreboard/B`
- `atp/scoreboard/C`
- `atp/upcoming`

`atp` contains the full JSON snapshot with `headline`, `totals`, `nextMatch`, `metadata`, `sections.live.items`, and `sections.upcoming.items`.

`atp/scoreboard` contains one rotating live-match text. In poll mode it prefers a selected live match whose score changed, and avoids showing the same changed match again when another changed match is available.

`atp/scoreboard/A`, `atp/scoreboard/B`, and `atp/scoreboard/C` contain fixed scoreboard slots for selected live matches. Slots are sticky while a match remains live. Court text can influence slot priority for major courts and numbered courts.

`atp/upcoming` contains up to three upcoming matches in local start-time order. Tomorrow's matches are prefixed with `I morgon`.

## Upstream Source

Default source:

```text
https://eu1.offering-api.kambicdn.com/offering/v2018/svenskaspel/listView/tennis/all/all/all/matches.json
```

The service adds Kambi/Svenska Spel query parameters such as `channel_id`, `client_id`, `lang`, `market`, `useCombined`, and `useCombinedLive`.

## Polling Behavior

In `--poll` mode:

- the first successful run publishes retained MQTT values
- later runs publish only when the selected live/upcoming score signature changes
- polling is fast while any selected match is live
- polling is slow when no match is live
- individual MQTT topics are also skipped when their serialized payload has not changed

## Notes

- CLI output and display strings are Swedish-oriented for Magnus' local display setup.
- The feed is betting/offering data, not the canonical ATP API.
- Upstream availability and schema can change without warning.
