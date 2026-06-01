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
const DEFAULT_MAX_LIVE_MATCHES = 3;
const DEFAULT_MAX_UPCOMING_MATCHES = 3;
const DEFAULT_LIVE_POLL_SECONDS = 30;
const DEFAULT_IDLE_POLL_SECONDS = 1800;
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

function formatDateKey(value) {
  if (!value) {
    return null;
  }

  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function getTomorrowDateKey() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return formatDateKey(tomorrow);
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

function parsePositiveIntegerEnv(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sortByStart(items) {
  return [...items].sort(compareByStart);
}

function compareByStart(a, b) {
  const aTime = a.start ? new Date(a.start).getTime() : Number.POSITIVE_INFINITY;
  const bTime = b.start ? new Date(b.start).getTime() : Number.POSITIVE_INFINITY;
  return aTime - bTime;
}

function compareByImportance(a, b) {
  const priorityDifference =
    (b.importance?.score ?? 0) - (a.importance?.score ?? 0);

  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  const aTime = a.start ? new Date(a.start).getTime() : Number.POSITIVE_INFINITY;
  const bTime = b.start ? new Date(b.start).getTime() : Number.POSITIVE_INFINITY;
  return aTime - bTime;
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

function createImportance(event) {
  const terms = getEventPathTerms(event);
  const searchText = getEventSearchText(event).toLowerCase();
  let score = 0;
  const reasons = [];

  if (terms.includes("grand_slam")) {
    score += 100;
    reasons.push("grand_slam");
  }

  if (terms.includes("atp")) {
    score += 60;
    reasons.push("atp");
  }

  if (/\b(masters|1000)\b/i.test(searchText)) {
    score += 30;
    reasons.push("masters");
  }

  if (/\b(final|semi|sf|qf|quarter)\b/i.test(searchText)) {
    score += 20;
    reasons.push("late_round");
  }

  return {
    score,
    terms,
    reasons
  };
}

function getLastName(name) {
  const parts = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return parts.at(-1) || "Okänd";
}

function createShortLabel(playerA, playerB) {
  return `${getLastName(playerA?.name)} - ${getLastName(playerB?.name)}`;
}

function normalizeMatchItem(item) {
  return {
    start: item.start ?? null,
    tournament: item.tournament ?? null,
    state: item.state ?? null,
    label: `${item.playerA?.name ?? "Okänd"} - ${item.playerB?.name ?? "Okänd"}`,
    shortLabel: createShortLabel(item.playerA, item.playerB),
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
    },
    importance: item.importance ?? { score: 0, terms: [], reasons: [] }
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
      importance: createImportance(item.event),
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

function selectImportantMatches(matches) {
  const maxLive = parsePositiveIntegerEnv(
    process.env.ATP_MQTT_MAX_LIVE,
    DEFAULT_MAX_LIVE_MATCHES
  );
  const maxUpcoming = parsePositiveIntegerEnv(
    process.env.ATP_MQTT_MAX_UPCOMING,
    DEFAULT_MAX_UPCOMING_MATCHES
  );

  return {
    liveMatches: matches
      .filter(match => match.state === "live")
      .sort(compareByImportance)
      .slice(0, maxLive)
      .sort(compareByStart),
    upcomingMatches: matches
      .filter(match => match.state === "upcoming")
      .sort(compareByStart)
      .slice(0, maxUpcoming)
  };
}

function createHeadline({ liveMatches }) {
  if (liveMatches.length > 0) {
    return sanitizeHeadlineText(
      liveMatches
        .map(match => `${match.shortLabel} ${match.score ?? ""}`.trim())
        .join(" • ")
    ).replace(/\s+/g, " ").trim();
  }

  return "Inga live-matcher";
}

function createLiveText(liveMatches) {
  return createHeadline({ liveMatches });
}

function createUpcomingText(upcomingMatches) {
  if (upcomingMatches.length === 0) {
    return "Inga kommande matcher";
  }

  const tomorrowKey = getTomorrowDateKey();

  return sanitizeHeadlineText(
    upcomingMatches
      .slice(0, DEFAULT_MAX_UPCOMING_MATCHES)
      .map(match => {
        const time = formatTime(match.start) ?? "--:--";
        const datePrefix = formatDateKey(match.start) === tomorrowKey ? "I morgon " : "";
        return `${datePrefix}${time} ${match.shortLabel}`;
      })
      .join(" • ")
  ).replace(/\s+/g, " ").trim();
}

function createSummarySnapshot(matches) {
  const { liveMatches, upcomingMatches } = selectImportantMatches(matches);
  const headline = createHeadline({ liveMatches, upcomingMatches });
  const nextMatch = liveMatches[0] ?? upcomingMatches[0] ?? null;
  const totalLive = matches.filter(match => match.state === "live").length;
  const totalUpcoming = matches.filter(match => match.state === "upcoming").length;

  return {
    timestamp: new Date().toISOString(),
    headline,
    totals: {
      matches: liveMatches.length + upcomingMatches.length,
      live: liveMatches.length,
      upcoming: upcomingMatches.length,
      availableMatches: matches.length,
      availableLive: totalLive,
      availableUpcoming: totalUpcoming
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
      upstream: "eu1.offering-api.kambicdn.com",
      selection: {
        maxLive: parsePositiveIntegerEnv(
          process.env.ATP_MQTT_MAX_LIVE,
          DEFAULT_MAX_LIVE_MATCHES
        ),
        maxUpcoming: parsePositiveIntegerEnv(
          process.env.ATP_MQTT_MAX_UPCOMING,
          DEFAULT_MAX_UPCOMING_MATCHES
        )
      }
    },
    sections: {
      live: { items: liveMatches },
      upcoming: { items: upcomingMatches }
    }
  };
}

function createMqttMessages(snapshot, topicPrefix) {
  return [
    { topic: `${topicPrefix}/text/live`, payload: createLiveText(snapshot.sections.live.items) },
    { topic: `${topicPrefix}/text/upcoming`, payload: createUpcomingText(snapshot.sections.upcoming.items) },
    { topic: `${topicPrefix}/json`, payload: snapshot }
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
      `Live: ${formatInteger(this.snapshot.totals.live)}`
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

  run() {
    this.printHeader();
    this.printLive();
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

function getPollingDelayMilliseconds(snapshot) {
  const liveSeconds = parsePositiveIntegerEnv(
    process.env.ATP_MQTT_LIVE_POLL_SECONDS,
    DEFAULT_LIVE_POLL_SECONDS
  );
  const idleSeconds = parsePositiveIntegerEnv(
    process.env.ATP_MQTT_IDLE_POLL_SECONDS,
    DEFAULT_IDLE_POLL_SECONDS
  );

  return (snapshot.totals.availableLive > 0 ? liveSeconds : idleSeconds) * 1000;
}

function createScoreSignature(snapshot) {
  const liveSignature = snapshot.sections.live.items
    .map(match => `live:${match.shortLabel}=${match.score ?? ""}`)
    .join("|");
  const upcomingSignature = snapshot.sections.upcoming.items
    .map(match => `upcoming:${match.start ?? ""}:${match.shortLabel}`)
    .join("|");

  return [liveSignature, upcomingSignature].filter(Boolean).join("|")
    || `idle:${snapshot.headline}`;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function serializeMqttPayload(payload) {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

async function publishSnapshotToMqtt(snapshot, config, state = null) {
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
  const messagesToPublish = state?.lastPayloadByTopic
    ? messages.filter(message => {
        const payload = serializeMqttPayload(message.payload);
        return state.lastPayloadByTopic.get(message.topic) !== payload;
      })
    : messages;

  for (const message of messagesToPublish) {
    const payload = serializeMqttPayload(message.payload);

    await new Promise((resolve, reject) => {
      client.publish(message.topic, payload, { retain: config.retain }, error => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    state?.lastPayloadByTopic?.set(message.topic, payload);
  }

  await new Promise(resolve => {
    client.end(false, resolve);
  });

  return messagesToPublish.length;
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

async function publishSnapshotIfChanged(snapshot, mqttConfig, state) {
  const scoreSignature = createScoreSignature(snapshot);

  if (state.lastScoreSignature === scoreSignature) {
    console.log("Poängen är oförändrad; hoppar över MQTT-publicering.");
    return 0;
  }

  const publishedCount = await publishSnapshotToMqtt(snapshot, mqttConfig, state);
  state.lastScoreSignature = scoreSignature;
  if (publishedCount === 0) {
    console.log("Inga MQTT-topics ändrades; hoppar över publicering.");
    return 0;
  }

  console.log(
    `Publicerade ${publishedCount} MQTT-meddelanden till ${mqttConfig.topicPrefix} (${snapshot.timestamp}).`
  );
  return publishedCount;
}

async function executeHourly(argv) {
  const mqttConfig = argv.publish ? createMqttConfig() : null;
  const publishState = {
    lastPayloadByTopic: new Map(),
    lastScoreSignature: null
  };

  while (true) {
    let snapshot = null;

    try {
      snapshot = await executeOnce({ ...argv, publish: false });

      if (argv.publish) {
        await publishSnapshotIfChanged(snapshot, mqttConfig, publishState);
      }
    } catch (error) {
      console.error(`Run failed at ${formatTimestamp(new Date())}: ${error.message}`);
    }

    const milliseconds = snapshot
      ? getPollingDelayMilliseconds(snapshot)
      : parsePositiveIntegerEnv(
          process.env.ATP_MQTT_IDLE_POLL_SECONDS,
          DEFAULT_IDLE_POLL_SECONDS
        ) * 1000;
    console.log(`Nästa uppdatering om ${Math.round(milliseconds / 1000)} sekunder.`);
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
      description: "Kör kontinuerligt med snabbare polling när matcher är live"
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
