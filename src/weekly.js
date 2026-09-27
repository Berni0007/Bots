import { config } from "./config.js";
import { fetchWarconLeaderboard } from "./warcon.js";
import { renderWeeklyImage } from "./weekly-image.js";

const LOGO_URL = "https://i.ibb.co/rRhNwJc1/4.png";
const MOSCOW_TZ = "Europe/Moscow";

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function playerName(row) {
  return String(row?.name || row?.steamId || "—").trim() || "—";
}

function kdOf(row) {
  const kills = num(row?.kills);
  const deaths = num(row?.deaths);
  if (deaths > 0) return kills / deaths;
  return kills > 0 ? kills : 0;
}

function formatKd(row) {
  return kdOf(row).toFixed(2);
}

function formatMinutes(value) {
  const minutes = Math.max(0, Math.round(num(value)));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} ч ${m} мин`;
  if (h) return `${h} ч`;
  return `${m} мин`;
}

function formatMoney(value) {
  return Math.round(num(value)).toLocaleString("ru-RU").replace(/\u00A0/g, " ");
}

function topBy(rows, score, { positive = false } = {}) {
  const list = [...rows].filter((row) => !positive || score(row) > 0);
  list.sort((a, b) => score(b) - score(a) || num(b.kills) - num(a.kills));
  return list[0] || null;
}

function rankMap(rows, score) {
  const sorted = [...rows].sort(
    (a, b) => score(b) - score(a) || num(b.kills) - num(a.kills),
  );
  return new Map(sorted.map((row, index) => [String(row.steamId), index + 1]));
}

function percentile(rank, total) {
  if (!rank || total <= 1) return 1;
  return 1 - (rank - 1) / (total - 1);
}

function packLeader(rows) {
  const candidates = rows.filter((row) => num(row.minutes) >= 60 && num(row.kills) > 0);
  if (!candidates.length) return null;

  const killsRank = rankMap(candidates, (row) => num(row.kills));
  const kdRank = rankMap(candidates, kdOf);
  const total = candidates.length;

  return [...candidates].sort((a, b) => {
    const aScore =
      0.7 * percentile(killsRank.get(String(a.steamId)), total) +
      0.3 * percentile(kdRank.get(String(a.steamId)), total);
    const bScore =
      0.7 * percentile(killsRank.get(String(b.steamId)), total) +
      0.3 * percentile(kdRank.get(String(b.steamId)), total);

    return (
      bScore - aScore ||
      num(b.kills) - num(a.kills) ||
      kdOf(b) - kdOf(a)
    );
  })[0];
}

function moscowParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: MOSCOW_TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function weeklyKey(date = new Date()) {
  const p = moscowParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function weeklyField(name, row, value, inline = true) {
  return {
    name,
    value: row ? `**${playerName(row)}**\n${value(row)}` : "Нет данных за неделю",
    inline,
  };
}

export async function buildWeeklyDigest() {
  const data = await fetchWarconLeaderboard({
    range: "7d",
    scope: "server",
    minMinutes: 60,
  });
  const rows = data?.rows || [];
  if (!rows.length) throw new Error("Warcon: нет данных leaderboard за 7 дней");

  const leader = packLeader(rows);
  const banker = topBy(rows, (row) => num(row.cash), { positive: true });
  const veteran = topBy(rows, (row) => num(row.minutes), { positive: true });
  const wins = topBy(rows, (row) => num(row.wins), { positive: true });
  const seed = topBy(rows, (row) => num(row.seedMinutes), { positive: true });

  return {
    serverId: data.serverId,
    total: data.total,
    rows,
    leader,
    banker,
    veteran,
    wins,
    seed,
  };
}

export function weeklyWebhookPayload(stats, { test = false } = {}) {
  const title = test ? "ТЕСТ • ПОБЕДИТЕЛИ НЕДЕЛИ" : "🏆 ПОБЕДИТЕЛИ НЕДЕЛИ";
  const embed = {
    color: 0xe8a317,
    author: {
      name: "ZARUBA · WARDOGS",
      icon_url: LOGO_URL,
    },
    title,
    description:
      "**Лучшие бойцы ZARUBA за последние 7 дней.**\nВ публикации — только победители своих номинаций.",
    fields: [
      weeklyField(
        "🐺 ЛИДЕР СТАИ",
        stats.leader,
        (row) => `${num(row.kills)} убийств  •  K/D ${formatKd(row)}`,
        false,
      ),
      weeklyField(
        "💰 БАНКИР",
        stats.banker,
        (row) => `${formatMoney(row.cash)} заработано`,
      ),
      weeklyField(
        "🕒 ВЕТЕРАН НЕДЕЛИ",
        stats.veteran,
        (row) => `${formatMinutes(row.minutes)} в игре`,
      ),
      weeklyField(
        "🏅 ЛИДЕР ПО ПОБЕДАМ",
        stats.wins,
        (row) => `${num(row.wins)} побед  •  ${num(row.matches)} матчей`,
      ),
      weeklyField(
        "🌱 SEED-БОЕЦ",
        stats.seed,
        (row) => `${formatMinutes(row.seedMinutes)} SEED-времени`,
      ),
    ],
    footer: {
      text: "ZARUBA SERVER · WARDOGS · последние 7 дней",
    },
    timestamp: new Date().toISOString(),
    thumbnail: {
      url: LOGO_URL,
    },
  };

  if (config.weeklyBannerUrl) {
    embed.image = { url: config.weeklyBannerUrl };
  }

  return {
    username: "ZARUBA · WARDOGS",
    avatar_url: LOGO_URL,
    embeds: [embed],
  };
}

export async function sendWeeklyDigest({ test = false } = {}) {
  const webhookUrl = String(config.weeklyWebhookUrl || "").trim();
  if (!webhookUrl) throw new Error("WEEKLY_WEBHOOK_URL не задан");

  const stats = await buildWeeklyDigest();
  const separator = webhookUrl.includes("?") ? "&" : "?";
  const target = `${webhookUrl}${separator}wait=true`;

  const rendered = await renderWeeklyImage(stats);
  if (rendered.ok && rendered.buffer) {
    const form = new FormData();
    form.append(
      "payload_json",
      JSON.stringify({
        username: "ZARUBA · WARDOGS",
        avatar_url: LOGO_URL,
        content: test
          ? "🧪 **Тест · Победители недели**"
          : "🏆 **Победители недели · ZARUBA WARDOGS**",
        allowed_mentions: { parse: [] },
      }),
    );
    form.append(
      "files[0]",
      new Blob([rendered.buffer], { type: "image/png" }),
      "zaruba-wardogs-weekly.png",
    );

    const response = await fetch(target, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Discord webhook ${response.status}${body ? `: ${body.slice(0, 180)}` : ""}`,
      );
    }

    return { ...stats, output: "image", imageReason: "" };
  }

  console.warn("weekly image:", rendered.reason || "рендер недоступен; использую embed");
  const payload = weeklyWebhookPayload(stats, { test });
  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Discord webhook ${response.status}${body ? `: ${body.slice(0, 180)}` : ""}`,
    );
  }

  return {
    ...stats,
    output: "embed",
    imageReason: rendered.reason || "рендер изображения недоступен",
  };
}

export function startWeeklyDigest({ store }) {
  if (!config.weeklyWebhookUrl) {
    console.log("weekly: WEEKLY_WEBHOOK_URL пуст — недельный отчёт отключён");
    return () => {};
  }

  let busy = false;

  const check = async () => {
    if (busy) return;
    const p = moscowParts();
    if (p.weekday !== "Sun" || Number(p.hour) < 19) return;

    const key = weeklyKey();
    if (store.weeklyDigestSent(key)) return;

    busy = true;
    try {
      const stats = await sendWeeklyDigest();
      store.markWeeklyDigestSent(key, Date.now());
      console.log(`weekly: отчёт отправлен, игроков в выборке ${stats.total}`);
    } catch (error) {
      console.warn("weekly:", error instanceof Error ? error.message : error);
    } finally {
      busy = false;
    }
  };

  void check();
  const timer = setInterval(() => void check(), 60_000);
  return () => clearInterval(timer);
}
