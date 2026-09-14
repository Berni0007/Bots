import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EmbedBuilder, REST, Routes } from "discord.js";
import { formatKd, matchAwards, prettyMode } from "./logic.js";

const LIVE_REFRESH_MS = 15_000;
const RESULT_RETRY_MS = 60_000;
const COLOR = 0xe8a317;
const ZARUBA_LOGO = "https://i.ibb.co/rRhNwJc1/4.png";

function safeRead(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function safeWrite(path, value) {
  try {
    writeFileSync(path, JSON.stringify(value), "utf8");
  } catch (error) {
    console.warn("discord output state:", error.message);
  }
}

function stateFile(databasePath) {
  return join(dirname(databasePath), "discord-output.json");
}

function scoreTable(status) {
  return (status?.factionScores || [])
    .map((row) => ({
      name: String(row?.name || "Команда").trim() || "Команда",
      score: Number(row?.score) || 0,
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function leaderText(scores) {
  if (!scores.length) return "Счёт команд пока недоступен.";
  const best = scores[0].score;
  const leaders = scores.filter((row) => row.score === best);
  if (leaders.length > 1) {
    return `**Ничья:** ${leaders.map((row) => row.name).join(" / ")} — **${best}**`;
  }
  const second = scores.find((row) => row.score < best);
  const gap = second ? best - second.score : 0;
  return [
    `**${leaders[0].name}** — **${best}**`,
    second ? `Отрыв от ${second.name}: **+${gap}**` : null,
  ].filter(Boolean).join("\n");
}

function scoreText(scores) {
  if (!scores.length) return "Счёт недоступен.";
  const medals = ["🥇", "🥈", "🥉"];
  return scores
    .map((row, index) => `${medals[index] || "•"} **${row.name}** — **${row.score}**`)
    .join("\n")
    .slice(0, 1024);
}

function factionText(roster, scores) {
  const byFaction = new Map();
  for (const player of roster || []) {
    const faction = String(player?.faction || "").trim() || "Без фракции";
    const key = faction.toLowerCase();
    const row = byFaction.get(key) || { name: faction, players: 0, kills: 0 };
    row.players += 1;
    row.kills += Number(player?.kills) || 0;
    byFaction.set(key, row);
  }

  const ordered = [];
  const used = new Set();
  for (const score of scores) {
    const key = score.name.toLowerCase();
    const row = byFaction.get(key);
    if (row) {
      ordered.push(row);
      used.add(key);
    }
  }
  for (const [key, row] of byFaction) {
    if (!used.has(key)) ordered.push(row);
  }

  if (!ordered.length) return "Нет данных по составам команд.";
  return ordered
    .map((row) => `**${row.name}** — ${row.players} игроков · ${row.kills} килов`)
    .join("\n")
    .slice(0, 1024);
}

function currentAwards(roster) {
  const players = [...(roster || [])];
  const dogi = players
    .filter((row) => (Number(row?.kills) || 0) > 0)
    .sort((a, b) =>
      (Number(b.kills) || 0) - (Number(a.kills) || 0) ||
      (Number(a.deaths) || 0) - (Number(b.deaths) || 0) ||
      (Number(b.cashEarned) || 0) - (Number(a.cashEarned) || 0)
    )[0] || null;
  const miser = players
    .filter((row) => (Number(row?.cashEarned) || 0) > 0)
    .sort((a, b) =>
      (Number(b.cashEarned) || 0) - (Number(a.cashEarned) || 0) ||
      (Number(b.kills) || 0) - (Number(a.kills) || 0)
    )[0] || null;
  return { dogi, miser };
}

function liveTop(roster) {
  return [...(roster || [])]
    .sort((a, b) =>
      (Number(b.kills) || 0) - (Number(a.kills) || 0) ||
      (Number(a.deaths) || 0) - (Number(b.deaths) || 0) ||
      (Number(b.cashEarned) || 0) - (Number(a.cashEarned) || 0)
    )
    .slice(0, 8)
    .map((player, index) => {
      const kills = Number(player.kills) || 0;
      const deaths = Number(player.deaths) || 0;
      return `${index + 1}. **${player.name}** — ${kills}/${deaths} · K/D **${formatKd(kills, deaths)}** · +$${Number(player.cashEarned) || 0}`;
    })
    .join("\n") || "Игроков пока нет.";
}

function liveEmbed(poller, servers) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: "ZARUBA", iconURL: ZARUBA_LOGO })
    .setTitle("⚔️ ИДУЩИЙ БОЙ")
    .setDescription("Текущая ситуация на сервере WARDOGS")
    .setThumbnail(ZARUBA_LOGO)
    .setTimestamp(new Date());

  for (const server of servers) {
    const health = poller.health(server.id);
    const state = poller.snapshot(server.id);
    if (!health.online || !state?.status) {
      embed.addFields({ name: server.name, value: "Сервер не отвечает.", inline: false });
      continue;
    }

    const status = state.status;
    const roster = state.roster || [];
    const scores = scoreTable(status);
    const awards = currentAwards(roster);
    const maxPlayers = status.players?.max || "—";
    const matchMin = Math.floor((Number(status.matchSeconds) || 0) / 60);

    embed.addFields(
      {
        name: status.serverName || server.name,
        value: [
          `**${status.map || "—"}** · ${prettyMode(status.experiences?.[0])}`,
          `👥 Онлайн: **${roster.length}/${maxPlayers}**`,
          `⏱ Время боя: **${matchMin} мин**`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "🏆 ЛИДИРУЕТ",
        value: leaderText(scores),
        inline: false,
      },
      {
        name: "СЧЁТ КОМАНД",
        value: scoreText(scores),
        inline: false,
      },
      {
        name: "БОЙЦЫ",
        value: factionText(roster, scores),
        inline: false,
      },
      {
        name: "ЛИДЕРЫ БОЯ",
        value: [
          awards.dogi ? `🔥 **ДОГИ МЕН сейчас:** ${awards.dogi.name} — **${Number(awards.dogi.kills) || 0}** килов` : "🔥 **ДОГИ МЕН сейчас:** —",
          awards.miser ? `💰 **Скряга сейчас:** ${awards.miser.name} — **+$${Number(awards.miser.cashEarned) || 0}**` : "💰 **Скряга сейчас:** —",
        ].join("\n"),
        inline: false,
      },
      {
        name: "ТОП БОЯ",
        value: liveTop(roster).slice(0, 1024),
        inline: false,
      },
    );
  }
  return embed;
}

function resultEmbed(result) {
  const snapshots = [...(result?.snapshots || [])]
    .filter((row) => row?.steamId)
    .sort((a, b) => (Number(b.kills) || 0) - (Number(a.kills) || 0) || (Number(a.deaths) || 0) - (Number(b.deaths) || 0));
  const awards = result?.awards || matchAwards(snapshots);
  const durationMin = Math.max(0, Math.floor(((Number(result?.endedAt) || 0) - (Number(result?.startedAt) || 0)) / 60000));
  const winners = (result?.winners || []).filter(Boolean);
  const top = snapshots.slice(0, 10)
    .map((row, index) => {
      const kills = Number(row.kills) || 0;
      const deaths = Number(row.deaths) || 0;
      return `${index + 1}. **${row.name || row.steamId}** — ${kills}/${deaths} · K/D **${formatKd(kills, deaths)}** · +$${Number(row.cashEarned) || 0}`;
    })
    .join("\n") || "Нет данных.";

  return new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: "ZARUBA", iconURL: ZARUBA_LOGO })
    .setTitle("🏁 ИТОГИ БОЯ")
    .setThumbnail(ZARUBA_LOGO)
    .setDescription([
      `**${result?.server?.name || "WARDOGS"}**`,
      `${result?.map || "—"} · ${result?.mode || "—"} · ${durationMin} мин`,
      winners.length ? `🏆 Победитель: **${winners.join(", ")}**` : null,
    ].filter(Boolean).join("\n"))
    .addFields(
      {
        name: "🔥 ДОГИ МЕН",
        value: awards.dogi ? `**${awards.dogi.name}** — **${Number(awards.dogi.kills) || 0}** килов` : "—",
        inline: true,
      },
      {
        name: "💰 Скряга",
        value: awards.miser ? `**${awards.miser.name}** — **+$${Number(awards.miser.cashEarned) || 0}** за бой` : "—",
        inline: true,
      },
      { name: "ТОП БОЯ", value: top.slice(0, 1024), inline: false },
    )
    .setTimestamp(new Date(result?.endedAt || Date.now()));
}

function resultKey(result) {
  if (!result) return "";
  return `${result?.server?.id || "?"}:${Number(result.startedAt) || 0}`;
}

function latestStoredResult(store, servers) {
  const db = store?.db;
  if (!db) return null;
  const meta = db.prepare(`
    SELECT server_id, started_at, MAX(ended_at) AS ended_at,
           MAX(map) AS map, MAX(mode) AS mode
    FROM match_stats
    GROUP BY server_id, started_at
    ORDER BY ended_at DESC
    LIMIT 1
  `).get();
  if (!meta) return null;

  const snapshots = db.prepare(`
    SELECT steam_id AS steamId, name, faction, kills, deaths,
           cash_end AS cashEnd, cash_peak AS cashPeak,
           cash_earned AS cashEarned, won
    FROM match_stats
    WHERE server_id = ? AND started_at = ?
    ORDER BY kills DESC, deaths ASC
  `).all(meta.server_id, meta.started_at);
  if (!snapshots.length) return null;

  const winners = [...new Set(snapshots.filter((row) => Number(row.won) === 1 && row.faction).map((row) => row.faction))];
  return {
    server: servers.find((server) => String(server.id) === String(meta.server_id)) || { id: String(meta.server_id), name: `СЕРВЕР ${meta.server_id}` },
    map: meta.map || "",
    mode: meta.mode || "",
    startedAt: Number(meta.started_at) || 0,
    endedAt: Number(meta.ended_at) || Date.now(),
    winners,
    snapshots,
    awards: matchAwards(snapshots),
  };
}

function errorText(error) {
  const parts = [error?.message];
  if (error?.code) parts.push(`code=${error.code}`);
  if (error?.status) parts.push(`status=${error.status}`);
  return parts.filter(Boolean).join(" · ") || String(error);
}

export function startAutomaticDiscordOutput({ token, liveChannelId, resultsChannelId, databasePath, poller, servers }) {
  if (!token || (!liveChannelId && !resultsChannelId)) return null;
  const rest = new REST({ version: "10" }).setToken(token);
  const file = stateFile(databasePath);
  const outputState = safeRead(file);
  let liveMessageId = outputState.liveMessageId || "";
  let lastResultKey = outputState.lastResultKey || "";
  let lastLiveAt = 0;
  let lastResultRetryAt = 0;
  let liveBusy = false;
  let resultBusy = false;

  function saveState() {
    outputState.liveMessageId = liveMessageId;
    outputState.lastResultKey = lastResultKey;
    safeWrite(file, outputState);
  }

  async function updateLive(force = false) {
    if (!liveChannelId || liveBusy) return;
    const now = Date.now();
    if (!force && now - lastLiveAt < LIVE_REFRESH_MS) return;
    lastLiveAt = now;
    liveBusy = true;
    const body = { embeds: [liveEmbed(poller, servers).toJSON()] };
    try {
      if (liveMessageId) {
        try {
          await rest.patch(Routes.channelMessage(liveChannelId, liveMessageId), { body });
          return;
        } catch {
          liveMessageId = "";
        }
      }
      const created = await rest.post(Routes.channelMessages(liveChannelId), { body });
      liveMessageId = String(created?.id || "");
      saveState();
      console.log(`discord: идущий бой -> ${liveChannelId}`);
    } catch (error) {
      console.warn("discord live:", errorText(error));
    } finally {
      liveBusy = false;
    }
  }

  async function postResult(result, force = false) {
    if (!resultsChannelId || resultBusy || !result) return false;
    const key = resultKey(result);
    if (!force && key && key === lastResultKey) return true;
    resultBusy = true;
    try {
      await rest.post(Routes.channelMessages(resultsChannelId), {
        body: { embeds: [resultEmbed(result).toJSON()] },
      });
      lastResultKey = key;
      saveState();
      console.log(`discord: итоги боя -> ${resultsChannelId} · ${key}`);
      return true;
    } catch (error) {
      console.warn(`discord results [${resultsChannelId}]:`, errorText(error));
      return false;
    } finally {
      resultBusy = false;
    }
  }

  async function recoverLatestResult(force = false) {
    if (!resultsChannelId || resultBusy) return;
    const now = Date.now();
    if (!force && now - lastResultRetryAt < RESULT_RETRY_MS) return;
    lastResultRetryAt = now;
    const latest = latestStoredResult(poller.store, servers);
    if (!latest) return;
    const key = resultKey(latest);
    if (key && key === lastResultKey) return;
    console.log(`discord: найден неотправленный итог ${key}, пробую отправить`);
    await postResult(latest);
  }

  poller.onOutputTick = () => {
    void updateLive(false);
    void recoverLatestResult(false);
  };
  poller.onMatchEnd = (result) => {
    console.log(`match: завершён ${result?.server?.name || "?"} · ${result?.map || "—"} · ${resultKey(result)}`);
    void postResult(result);
  };

  void updateLive(true);
  setTimeout(() => void recoverLatestResult(true), 5_000);
  return { updateLive, postResult, recoverLatestResult };
}
