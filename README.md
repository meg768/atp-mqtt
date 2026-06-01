# atp-mqtt

Det här repot hämtar ATP-/Grand Slam-matchdata direkt från den publika Kambi/Svenska Spel-feeden och kan publicera en kort headline samt JSON-data till MQTT.

Första versionen fokuserar på sådant som passar bra på en display:

- live-matcher
- en kort huvudrad

Det finns ännu ingen separat nyhetsfeed i projektet. "Senaste nytt" betyder därför live-läge.

Projektet är fristående och beror inte på `tennis.egelberg.se` eller något annat lokalt ATP-projekt.

## Datakälla

Standardkälla är den publika tennis-feeden via Kambi/Svenska Spel:

- `GET https://eu1.offering-api.kambicdn.com/offering/v2018/svenskaspel/listView/tennis/all/all/all/matches.json`

Projektet lägger själv på query-parametrar som `channel_id`, `client_id`, `lang`, `market`, `useCombined` och `useCombinedLive`, och normaliserar sedan svaret till ett enklare internt format.

Eftersom Grand Slam-turneringar hos Kambi inte alltid ligger under `/tennis/atp` hämtar projektet den bredare tennis-feeden och filtrerar sedan till ATP- och Grand Slam-events. Uppenbara WTA-, Challenger-, UTR-, dam- och dubbelmatcher filtreras bort.

För MQTT-output väljer projektet bara de viktigaste matcherna:

- Grand Slam före vanlig ATP
- Masters/1000 och sena rundor får extra prioritet om feeden exponerar sådan text
- standardgräns: högst 3 live-matcher
- standardgräns: högst 3 kommande matcher

Gränserna kan ändras med `ATP_MQTT_MAX_LIVE` och `ATP_MQTT_MAX_UPCOMING`.

Kontinuerlig publicering pollar snabbare när matcher är live:

- standard live: var 30:e sekund
- standard utan live-match: var 30:e minut
- ändra med `ATP_MQTT_LIVE_POLL_SECONDS` och `ATP_MQTT_IDLE_POLL_SECONDS`
- MQTT publiceras bara när score-signaturen för de utvalda live-matcherna ändras, plus första publiceringen efter processstart

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

Kontinuerlig publicering:

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
- `atp/text`
- `atp/json`

`atp` innehåller bara en kort textsträng för displayer. När matcher är live är texten efternamn och poäng för de viktigaste live-matcherna.
`atp/text` innehåller samma korta textsträng som `atp`, som en konsekvent text-topic.
`atp/json` innehåller hela snapshotten med samma struktur som appen redan använder internt: `summary`-fälten plus `sections.live.items` och `sections.upcoming.items`.
Exempel:

```json
{
  "timestamp": "2026-05-15T20:00:00.000Z",
  "headline": "Sinner-Medvedev 6-2 5-7 4-2 [40-AD] • Alcaraz-Djokovic 6-4 3-2 [15-0]",
  "totals": {
    "matches": 2,
    "live": 2,
    "upcoming": 0,
    "availableMatches": 7,
    "availableLive": 2,
    "availableUpcoming": 5
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
    "upstream": "eu1.offering-api.kambicdn.com",
    "selection": {
      "maxLive": 3
    }
    }
  },
  "sections": {
    "live": {
      "items": []
    },
    "upcoming": {
      "items": []
    }
  }
}
```
