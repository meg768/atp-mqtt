#!/usr/bin/env node

require("dotenv").config();

const os = require("node:os");
const { execFileSync } = require("node:child_process");
const mqtt = require("mqtt");

const DEFAULT_MQTT_TOPIC_PREFIX = "atp";
const DEFAULT_ODDSET_API_URL =
  "https://eu1.offering-api.kambicdn.com/offering/v2018/svenskaspel/listView/tennis/all/all/all/matches.json";
const TIMEZONE = "Europe/Stockholm";
const SOURCE_DESCRIPTION = "Kambi/Svenska Spel ATP Oddset";
const INCLUDED_COMPETITION_TERMS = new Set(["atp", "grand_slam"]);
const EXCLUDED_COMPETITION_TERMS = new Set([
  "wta",
  "challenger",
  "challenger_qual_",
  "utr_pro_tennis_series",
  "utr_pro_tennis_series_women"
]);
const EXCLUDED_EVENT_TEXT_PATTERN =
  /(^|[\s-])(damer|damsingel|damdubbel|women|womens|ladies|dubbel|doubles)([\s-]|$)/i;

function normalizeSpaces(value) {
  return String(value).replace(/\u00a0/g, " ");
}

function formatInteger(value) {
  return normalizeSpaces(new Intl.NumberFormat("sv-SE").format(value));
}

function formatTime(value) {
  if (!value) {
    return null;
  }

  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatTimestamp(timestamp) {
  const value =
    timestamp instanceof Date || typeof timestamp === "number"
      ? timestamp
      : new Date(timestamp);

  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(value);
}

function sanitizeHeadlineText(value) {
  return String(value)
    .replace(/−/g, "-")
    .replace(/[–—]/g, "-");
}

function sumBy(items, selector) {
  return items.reduce((total, item) => total + selector(item), 0);
}

function sortByStart(items) {
  return [...items].sort((a, b) => {
    const aTime = a.start ? new Date(a.start).getTime() : Number.POSITIVE_INFINITY;
    const bTime = b.start ? new Date(b.start).getTime() : Number.POSITIVE_INFINITY;
    return aTime - bTime;
  });
}

async function requestJson(url) {
  try {
    if (typeof fetch !== "function") {
      throw new Error("fetch saknas");
    }

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    return requestJsonWithCurl(url);
  }
}

function requestJsonWithCurl(url) {
  const output = execFileSync("curl", ["-s", url], { encoding: "utf8" });
  return JSON.parse(output);
}

function isNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function buildSetScores(item) {
  const homeSets = item.liveData?.statistics?.sets?.home ?? [];
  const awaySets = item.liveData?.statistics?.sets?.away ?? [];
  const setCount = Math.max(homeSets.length, awaySets.length);
  const scores = [];

  for (let index = 0; index < setCount; index += 1) {
    const home = homeSets[index];
    const away = awaySets[index];

    if (!isNonNegativeNumber(home) || !isNonNegativeNumber(away)) {
      continue;
    }

    if (home === 0 && away === 0) {
      continue;
    }

    scores.push(`${home}-${away}`);
  }

  return scores;
}

function buildGameScore(item) {
  const home = item.liveData?.score?.home ?? null;
  const away = item.liveData?.score?.away ?? null;

  if (home == null || away == null) {
    return null;
  }

  return `${home}-${away}`;
}

function buildScore(item) {
  if (!item.liveData) {
    return null;
  }

  const setScores = buildSetScores(item);
  const gameScore = buildGameScore(item);
  const score = setScores.join(" ");

  if (gameScore) {
    return score ? `${score} [${gameScore}]` : `[${gameScore}]`;
  }

  return score || null;
}

function buildOddsetUrl(url) {
  const result = new URL(url);
  result.searchParams.set("channel_id", "1");
  result.searchParams.set("client_id", "200");
  result.searchParams.set("lang", "sv_SE");
  result.searchParams.set("market", "SE");
  result.searchParams.set("useCombined", "true");
  result.searchParams.set("useCombinedLive", "true");
  return result.toString();
}

function getEventPathTerms(event) {
  return Array.isArray(event?.path)
    ? event.path
        .map(item => String(item?.termKey ?? "").trim().toLowerCase())
        .filter(Boolean)
    : [];
}

function getEventSearchText(event) {
  const pathText = Array.isArray(event?.path)
    ? event.path
        .flatMap(item => [item?.name, item?.englishName, item?.termKey])
        .filter(Boolean)
        .join(" ")
    : "";

  return [event?.name, event?.group, pathText].filter(Boolean).join(" ");
}

function isRelevantAtpEvent(item) {
  const event = item?.event;
  const terms = getEventPathTerms(event);
  const searchText = getEventSearchText(event);

  if (!["STARTED", "NOT_STARTED"].includes(event?.state)) {
    return false;
  }

  if (EXCLUDED_EVENT_TEXT_PATTERN.test(searchText)) {
    return false;
  }

  if (terms.some(term => EXCLUDED_COMPETITION_TERMS.has(term))) {
    return false;
  }

  return terms.some(term => INCLUDED_COMPETITION_TERMS.has(term));
}

function normalizeMatchItem(item) {
  return {
    start: item.start ?? null,
    tournament: item.tournament ?? null,
    state: item.state ?? null,
    label: `${item.playerA?.name ?? "Okänd"} - ${item.playerB?.name ?? "Okänd"}`,
    score: item.score ?? null,
    serve: item.serve ?? null,
    playerA: {
      id: item.playerA?.id ?? null,
      name: item.playerA?.name ?? null,
      odds: item.playerA?.odds ?? null
    },
    playerB: {
      id: item.playerB?.id ?? null,
      name: item.playerB?.name ?? null,
      odds: item.playerB?.odds ?? null
    }
  };
}

async function fetchMatches() {
  const sourceUrl = process.env.ODDSET_API_URL || DEFAULT_ODDSET_API_URL;
  const data = await requestJson(buildOddsetUrl(sourceUrl));
  const events = Array.isArray(data?.events) ? data.events : [];

  return events.filter(isRelevantAtpEvent).map(item => {
    const matchOdds = Array.isArray(item.betOffers)
      ? item.betOffers.find(offer => offer?.criterion?.label === "Matchodds")
      : null;

    return normalizeMatchItem({
      start: item.event?.start ?? null,
      tournament: item.event?.group ?? null,
      state: item.event?.state === "STARTED" ? "live" : "upcoming",
      score: buildScore(item),
      serve: item.liveData
        ? item.liveData?.statistics?.sets?.homeServe
          ? "player"
          : "opponent"
        : null,
      playerA: {
        id: item.event?.home ?? null,
        name: item.event?.homeName ?? null,
        odds:
          typeof matchOdds?.outcomes?.[0]?.odds === "number"
            ? matchOdds.outcomes[0].odds / 1000
            : null
      },
      playerB: {
        id: item.event?.away ?? null,
        name: item.event?.awayName ?? null,
        odds:
          typeof matchOdds?.outcomes?.[1]?.odds === "number"
            ? matchOdds.outcomes[1].odds / 1000
            : null
      }
    });
  });
}

function createHeadline({ liveMatches, upcomingMatches }) {
  const firstLive = liveMatches[0] ?? null;
  const firstUpcoming = upcomingMatches[0] ?? null;

  if (firstLive) {
    return sanitizeHeadlineText(
      `ATP LIVE ${firstLive.tournament}: ${firstLive.label} ${firstLive.score ?? ""} • ${formatInteger(liveMatches.length)} live • ${formatInteger(upcomingMatches.length)} kommande`
    ).replace(/\s+/g, " ").trim();
  }

  if (firstUpcoming) {
    return sanitizeHeadlineText(
      `ATP nästa ${firstUpcoming.tournament}: ${firstUpcoming.label} ${formatTime(firstUpcoming.start) ?? ""} • ${formatInteger(upcomingMatches.length)} kommande`
    ).replace(/\s+/g, " ").trim();
  }

  return "ATP: inga live- eller kommande matcher";
}

function createSummarySnapshot(matches) {
  const liveMatches = sortByStart(matches.filter(match => match.state === "live"));
  const upcomingMatches = sortByStart(matches.filter(match => match.state === "upcoming"));
  const headline = createHeadline({ liveMatches, upcomingMatches });
  const nextMatch = liveMatches[0] ?? upcomingMatches[0] ?? null;

  return {
    timestamp: new Date().toISOString(),
    headline,
    totals: {
      matches: matches.length,
      live: liveMatches.length,
      upcoming: upcomingMatches.length
    },
    nextMatch:
      nextMatch == null
        ? null
        : {
            start: nextMatch.start,
            tournament: nextMatch.tournament,
            state: nextMatch.state,
            label: nextMatch.label
          },
    metadata: {
      source: SOURCE_DESCRIPTION,
      timezone: TIMEZONE,
      upstream: "eu1.offering-api.kambicdn.com"
    },
    sections: {
      live: { items: liveMatches },
      upcoming: { items: upcomingMatches }
    }
  };
}

function createSummaryPayload(snapshot) {
  return {
    timestamp: snapshot.timestamp,
    headline: snapshot.headline,
    totals: snapshot.totals,
    nextMatch: snapshot.nextMatch,
    metadata: snapshot.metadata
  };
}

function createLivePayload(snapshot) {
  return {
    timestamp: snapshot.timestamp,
    items: snapshot.sections.live.items
  };
}

function createUpcomingPayload(snapshot) {
  return {
    timestamp: snapshot.timestamp,
    items: snapshot.sections.upcoming.items
  };
}

function createMqttMessages(snapshot, topicPrefix) {
  return [
    { topic: topicPrefix, payload: snapshot.headline },
    { topic: `${topicPrefix}/summary`, payload: createSummaryPayload(snapshot) },
    { topic: `${topicPrefix}/live`, payload: createLivePayload(snapshot) },
    { topic: `${topicPrefix}/upcoming`, payload: createUpcomingPayload(snapshot) }
  ];
}

function padCell(value, width, align = "left") {
  const stringValue = String(value);
  return align === "right"
    ? stringValue.padStart(width, " ")
    : stringValue.padEnd(width, " ");
}

function renderTable(rows, columns) {
  if (rows.length === 0) {
    console.log("Inga rader att visa.");
    return;
  }

  const widths = columns.reduce((result, column) => {
    const cellWidths = rows.map(row => String(row[column.key]).length);
    result[column.key] = Math.max(column.label.length, ...cellWidths);
    return result;
  }, {});

  const header = columns
    .map(column => padCell(rowValue(column.label), widths[column.key], column.align))
    .join("  ");
  const separator = columns
    .map(column => "-".repeat(widths[column.key]))
    .join("  ");

  console.log(header);
  console.log(separator);

  for (const row of rows) {
    console.log(
      columns
        .map(column => padCell(rowValue(row[column.key]), widths[column.key], column.align))
        .join("  ")
    );
  }
}

function rowValue(value) {
  return value == null || value === "" ? "-" : String(value);
}

function createTableRows(items) {
  return items.map(item => ({
    start: formatTime(item.start) ?? "-",
    turnering: item.tournament ?? "-",
    match: item.label,
    status: item.state ?? "-",
    score: item.score ?? "-"
  }));
}

class AtpCli {
  constructor(snapshot) {
    this.snapshot = snapshot;
  }

  printHeader() {
    console.log("ATP");
    console.log(`Källa: ${this.snapshot.metadata.source}`);
    console.log(`Uppdaterad: ${formatTimestamp(this.snapshot.timestamp)}`);
    console.log(this.snapshot.headline);
    console.log(
      `Live: ${formatInteger(this.snapshot.totals.live)} | Kommande: ${formatInteger(this.snapshot.totals.upcoming)}`
    );
  }

  printLive() {
    console.log("");
    console.log("Live");

    if (this.snapshot.sections.live.items.length === 0) {
      console.log("Inga live-matcher.");
      return;
    }

    renderTable(createTableRows(this.snapshot.sections.live.items), [
      { key: "start", label: "Start" },
      { key: "turnering", label: "Turnering" },
      { key: "match", label: "Match" },
      { key: "status", label: "Status" },
      { key: "score", label: "Score" }
    ]);
  }

  printUpcoming() {
    console.log("");
    console.log("Kommande");

    if (this.snapshot.sections.upcoming.items.length === 0) {
      console.log("Inga kommande matcher.");
      return;
    }

    renderTable(createTableRows(this.snapshot.sections.upcoming.items.slice(0, 10)), [
      { key: "start", label: "Start" },
      { key: "turnering", label: "Turnering" },
      { key: "match", label: "Match" },
      { key: "status", label: "Status" },
      { key: "score", label: "Score" }
    ]);
  }

  run() {
    this.printHeader();
    this.printLive();
    this.printUpcoming();
  }
}

function parseBooleanEnv(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function normalizeTopicPrefix(value) {
  const normalized = String(value ?? DEFAULT_MQTT_TOPIC_PREFIX)
    .trim()
    .replace(/^\/+|\/+$/g, "");

  return normalized || DEFAULT_MQTT_TOPIC_PREFIX;
}

function createMqttConfig() {
  return {
    url: process.env.MQTT_URL || null,
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    topicPrefix: normalizeTopicPrefix(
      process.env.MQTT_TOPIC || process.env.MQTT_TOPIC_PREFIX
    ),
    clientId:
      process.env.MQTT_CLIENT_ID || `atp-mqtt-${os.hostname()}-${process.pid}`,
    retain: parseBooleanEnv(process.env.MQTT_RETAIN, true)
  };
}

function getTimePartsInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(date);

  return parts.reduce((result, part) => {
    if (part.type === "hour" || part.type === "minute" || part.type === "second") {
      result[part.type] = Number(part.value);
    }

    return result;
  }, {});
}

function getMillisecondsUntilNextHour(timeZone) {
  const now = new Date();
  const { minute = 0, second = 0 } = getTimePartsInTimeZone(now, timeZone);
  const milliseconds = now.getMilliseconds();
  return ((60 - minute) * 60 - second) * 1000 - milliseconds;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function publishSnapshotToMqtt(snapshot, config) {
  if (!config.url) {
    throw new Error("MQTT_URL saknas. Ange den i .env eller miljön.");
  }

  const client = mqtt.connect(config.url, {
    username: config.username,
    password: config.password,
    clientId: config.clientId
  });

  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });

  const messages = createMqttMessages(snapshot, config.topicPrefix);

  for (const message of messages) {
    const payload =
      typeof message.payload === "string"
        ? message.payload
        : JSON.stringify(message.payload);

    await new Promise((resolve, reject) => {
      client.publish(message.topic, payload, { retain: config.retain }, error => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  await new Promise(resolve => {
    client.end(false, resolve);
  });

  return messages.length;
}

async function executeOnce(argv) {
  const matches = await fetchMatches();
  const snapshot = createSummarySnapshot(matches);
  const app = new AtpCli(snapshot);
  app.run();

  if (argv.publish) {
    const mqttConfig = createMqttConfig();
    const publishedCount = await publishSnapshotToMqtt(snapshot, mqttConfig);
    console.log(
      `Publicerade ${publishedCount} MQTT-meddelanden till ${mqttConfig.topicPrefix} (${snapshot.timestamp}).`
    );
  }

  return snapshot;
}

async function executeHourly(argv) {
  while (true) {
    try {
      await executeOnce(argv);
    } catch (error) {
      console.error(`Run failed at ${formatTimestamp(new Date())}: ${error.message}`);
    }

    const milliseconds = getMillisecondsUntilNextHour(TIMEZONE);
    await sleep(milliseconds);
  }
}

async function main() {
  const yargs = (await import("yargs/yargs")).default;
  const { hideBin } = await import("yargs/helpers");

  const argv = yargs(hideBin(process.argv))
    .scriptName("atp-mqtt")
    .usage("$0 [--publish] [--hourly]")
    .option("publish", {
      type: "boolean",
      default: false,
      description: "Publicera huvudtopic och JSON-data till MQTT"
    })
    .option("hourly", {
      type: "boolean",
      default: false,
      description: "Kör varje hel timme i Europe/Stockholm"
    })
    .help()
    .alias("help", "h")
    .strict()
    .parse();

  if (argv.hourly) {
    await executeHourly(argv);
    return;
  }

  await executeOnce(argv);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
