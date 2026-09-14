import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EmbedBuilder, REST, Routes } from "discord.js";
import { prettyMode } from "./logic.js";

const LIVE_REFRESH_MS = 15_000;
const COLOR = 0xe8a317;

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

function liveEmbed(poller, servers) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("Идущий бой")
    .setDescription("Текущая ситуация на сервере WARDOGS")
    .setTimestamp(new Date());

  for (const server of servers) {
    const health = poller.health(server.id);
    const state = poller.snapshot(server.id);
    if (!health.online || !state?.status) {
      embed.addFields({ name: server.name, value: "Сервер не отвечает.", inline: false });
      continue;
    }

    const status = state.status;
    const scores = (status.factionScores || [])
      .map((row) => `${row.name}: **${Number(row.score) || 0}**`)
      .join(" · ") || "Счёт недоступен";
    const top = [...(state.roster || [])]
      .sort((a, b) => (Number(b.kills) || 0) - (Number(a.kills) || 0) || (Number(b.cashEarned) || 0) - (Number(a.cashEarned) || 0))
      .slice(0, 8)
      .map((player, index) => `${index + 1}. **${player.name}** — ${player.kills}/${player.deaths} · +$${player.cashEarned || 0}`)
      .join("\n") || "Игроков пока нет.";

    embed.addFields({
      name: status.serverName || server.name,
      value: [
        `**${status.map || "—"}** · ${prettyMode(status.experiences?.[0])}`,
        `Онлайн: **${state.roster.length}/${status.players?.max || "—"}** · время боя: **${Math.floor((Number(status.matchSeconds) || 0) / 60)} мин**`,
        scores,
        `**Топ текущего боя**\n${top}`,
      ].join("\n"),
      inline: false,
    });
  }
  return embed;
}

function resultEmbed(result) {
  const snapshots = [...(result?.snapshots || [])]
    .filter((row) => row?.steamId)
    .sort((a, b) => (Number(b.kills) || 0) - (Number(a.kills) || 0) || (Number(a.deaths) || 0) - (Number(b.deaths) || 0));
  const awards = result?.awards || {};
  const durationMin = Math.max(0, Math.floor(((Number(result?.endedAt) || 0) - (Number(result?.startedAt) || 0)) / 60000));
  const winners = (result?.winners || []).filter(Boolean);
  const top = snapshots.slice(0, 10)
    .map((row, index) => `${index + 1}. **${row.name || row.steamId}** — ${Number(row.kills) || 0}/${Number(row.deaths) || 0} · +$${Number(row.cashEarned) || 0}`)
    .join("\n") || "Нет данных.";

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("Итоги боя")
    .setDescription([
      `**${result?.server?.name || "WARDOGS"}**`,
      `${result?.map || "—"} · ${result?.mode || "—"} · ${durationMin} мин`,
      winners.length ? `Победитель: **${winners.join(", ")}**` : null,
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
      { name: "Топ боя", value: top.slice(0, 1024), inline: false },
    )
    .setTimestamp(new Date(result?.endedAt || Date.now()));
  return embed;
}

export function startAutomaticDiscordOutput({ token, liveChannelId, resultsChannelId, databasePath, poller, servers }) {
  if (!token || (!liveChannelId && !resultsChannelId)) return null;
  const rest = new REST({ version: "10" }).setToken(token);
  const file = stateFile(databasePath);
  const saved = safeRead(file);
  let liveMessageId = saved.liveMessageId || "";
  let lastLiveAt = 0;
  let liveBusy = false;

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
      safeWrite(file, { ...saved, liveMessageId });
      console.log(`discord: идущий бой -> ${liveChannelId}`);
    } catch (error) {
      console.warn("discord live:", error.message);
    } finally {
      liveBusy = false;
    }
  }

  async function postResult(result) {
    if (!resultsChannelId) return;
    try {
      await rest.post(Routes.channelMessages(resultsChannelId), {
        body: { embeds: [resultEmbed(result).toJSON()] },
      });
      console.log(`discord: итоги боя -> ${resultsChannelId}`);
    } catch (error) {
      console.warn("discord results:", error.message);
    }
  }

  poller.onOutputTick = () => void updateLive(false);
  poller.onMatchEnd = (result) => postResult(result);
  void updateLive(true);
  return { updateLive, postResult };
}
