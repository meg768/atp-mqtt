# atp-mqtt

Det här repot hämtar ATP-/Grand Slam-matchdata direkt från den publika Kambi/Svenska Spel-feeden och kan publicera en kort headline samt JSON-data till MQTT.

Första versionen fokuserar på sådant som passar bra på en display:

- live-matcher
- nästa kommande matcher
- en kort huvudrad

Det finns ännu ingen separat nyhetsfeed i projektet. "Senaste nytt" betyder därför i första hand live-läge och nästa ATP-match att hålla koll på.

Projektet är fristående och beror inte på `tennis.egelberg.se` eller något annat lokalt ATP-projekt.

## Datakälla

Standardkälla är den publika tennis-feeden via Kambi/Svenska Spel:

- `GET https://eu1.offering-api.kambicdn.com/offering/v2018/svenskaspel/listView/tennis/all/all/all/matches.json`

Projektet lägger själv på query-parametrar som `channel_id`, `client_id`, `lang`, `market`, `useCombined` och `useCombinedLive`, och normaliserar sedan svaret till ett enklare internt format.

Eftersom Grand Slam-turneringar hos Kambi inte alltid ligger under `/tennis/atp` hämtar projektet den bredare tennis-feeden och filtrerar sedan till ATP- och Grand Slam-events. Uppenbara WTA-, Challenger-, UTR-, dam- och dubbelmatcher filtreras bort.

Den uppströmsfeeden innehåller bland annat:

- `start`
- `tournament`
- `state` (`live` eller `upcoming`)
- `score`
- `serve`
- `playerA`
- `playerB`

Exempel:

```json
[
  {
    "start": "2026-05-15T17:23:00Z",
    "tournament": "Rom",
    "state": "live",
    "score": "6-2 5-7 4-2 [40-AD]",
    "serve": "opponent",
    "playerA": {
      "name": "Jannik Sinner",
      "odds": 1.06,
      "id": "S0AG"
    },
    "playerB": {
      "name": "Daniil Medvedev",
      "odds": 9,
      "id": "MM58"
    }
  }
]
```

## Körning

Installera beroenden:

```bash
npm install
```

Lokal körning:

```bash
npm run fetch
```

Eller direkt:

```bash
node run.js
```

Timvis publicering:

```bash
node run.js --publish --hourly
```

## MQTT

Publicera till MQTT:

```bash
node run.js --publish
```

Exempel med miljövariabler:

```bash
MQTT_URL=mqtt://127.0.0.1:1883 \
MQTT_TOPIC=atp \
MQTT_USERNAME=myuser \
MQTT_PASSWORD=secret \
node run.js --publish
```

Projektet laddar `.env` automatiskt via `dotenv`.

`MQTT_TOPIC` i `.env` anger exakt topic. Standard är `atp`.

Publicerade topics:

- `atp`
- `atp/summary`
- `atp/live`
- `atp/upcoming`

`atp` innehåller bara en kort textsträng för displayer.

`atp/summary` innehåller en sammanfattning:

```json
{
  "timestamp": "2026-05-15T20:00:00.000Z",
  "headline": "ATP LIVE Rom: Sinner-Medvedev 6-2 5-7 4-2 [40-AD] • 1 live • 5 kommande",
  "totals": {
    "matches": 6,
    "live": 1,
    "upcoming": 5
  },
  "nextMatch": {
    "start": "2026-05-15T17:23:00Z",
    "tournament": "Rom",
    "state": "live",
    "label": "Jannik Sinner - Daniil Medvedev"
  },
  "metadata": {
    "source": "Kambi/Svenska Spel ATP Oddset",
    "timezone": "Europe/Stockholm",
    "upstream": "eu1.offering-api.kambicdn.com"
  }
}
```

`atp/live` och `atp/upcoming` använder samma item-schema:

```json
{
  "timestamp": "2026-05-15T20:00:00.000Z",
  "items": [
    {
      "start": "2026-05-15T17:23:00Z",
      "tournament": "Rom",
      "state": "live",
      "label": "Jannik Sinner - Daniil Medvedev",
      "score": "6-2 5-7 4-2 [40-AD]",
      "serve": "opponent",
      "playerA": {
        "id": "S0AG",
        "name": "Jannik Sinner",
        "odds": 1.06
      },
      "playerB": {
        "id": "MM58",
        "name": "Daniil Medvedev",
        "odds": 9
      }
    }
  ]
}
```
