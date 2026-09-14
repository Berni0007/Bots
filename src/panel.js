import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThumbnailBuilder,
} from "discord.js";
import { formatTopCsv, formatTopLine, persistTop100, TOP_LIMIT } from "./leaderboard.js";
import { formatHours, formatKd, prettyMode } from "./logic.js";

const V2 = MessageFlags.IsComponentsV2;

export const COLOR = 0xe8a317;
export const PANEL_ASK = "wd:ask";
export const PANEL_ME = "wd:me";
export const PANEL_TOP = "wd:top";
export const PANEL_LIVE = "wd:live";
export const PANEL_MODAL = "wd:stats";

const METRIC_LABEL = {
  kills: "Килы",
  kd: "K/D",
  hours: "Часы",
  cash: "Кэш",
  wins: "Победы",
  matches: "Игры",
  match_kills: "ДОГИ МЕН · килы за бой",
  match_cash: "Скряга · заработок за бой",
};

function serverSnapshot(poller, server) {
  const state = poller?.snapshot(server.id);
  const online = Math.max(state?.roster?.length || 0, Number(state?.status?.players?.current) || 0);
  const max = state?.status?.players?.max || "—";
  const map = state?.status?.map || "карта неизвестна";
  const mode = prettyMode(state?.status?.experiences?.[0]);
  const matchMin = Math.floor((Number(state?.status?.matchSeconds) || 0) / 60);
  const ranked = [...(state?.roster || [])].sort((a, b) => b.kills - a.kills).slice(0, 3);
  const top = ranked.map((player, index) => `\`${index + 1}\` **${player.name}** · **${player.kills}**`);
  const topNames = ranked.map((player) => `${player.name} ${player.kills}`);
  const awards = poller?.lastAwards?.(server.id) || null;
  return { name: server.name, online, max, map, mode, matchMin, top, topNames, awards };
}

function txt(content) {
  return new TextDisplayBuilder().setContent(content);
}

function line(large = false) {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);
}

function panelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PANEL_ASK).setStyle(ButtonStyle.Primary).setEmoji("📊").setLabel("Статистика"),
    new ButtonBuilder().setCustomId(PANEL_ME).setStyle(ButtonStyle.Success).setEmoji("👤").setLabel("Моя стата"),
    new ButtonBuilder().setCustomId(PANEL_TOP).setStyle(ButtonStyle.Secondary).setEmoji("🏆").setLabel("Топ"),
    new ButtonBuilder().setCustomId(PANEL_LIVE).setStyle(ButtonStyle.Secondary).setEmoji("📡").setLabel("Онлайн"),
  );
}

function serverBlock(snap) {
  const last = snap.awards
    ? [
        snap.awards.dogi ? `**ДОГИ МЕН:** ${snap.awards.dogi.name} · ${snap.awards.dogi.kills} килов` : null,
        snap.awards.miser ? `**Скряга:** ${snap.awards.miser.name} · +$${snap.awards.miser.cashEarned || 0}` : null,
      ].filter(Boolean).join(" · ")
    : "";
  return [
    `## ${snap.name}`,
    `**${snap.online}** / **${snap.max}** онлайн · ${snap.map} · ${snap.mode || "матч"} · ${snap.matchMin}м`,
    last ? `Последний бой · ${last}` : null,
  ].filter(Boolean).join("\n");
}

export async function panelMessage(poller, servers, totals = {}) {
  const snaps = (servers || []).map((server) => serverSnapshot(poller, server));
  const games = Number(totals.games) || 0;
  const players = Number(totals.players) || 0;
  const files = [];
  const container = new ContainerBuilder()
    .setAccentColor(COLOR)
    .addTextDisplayComponents(
      txt("# WARDOGS STATS"),
      txt(`Игр на серверах · **${games}**\nИгроков в базе · **${players}**`),
    )
    .addSeparatorComponents(line());

  for (const [index, snap] of snaps.entries()) {
    if (index) container.addSeparatorComponents(line());
    container.addTextDisplayComponents(txt(serverBlock(snap)));
  }

  container
    .addSeparatorComponents(line(true))
    .addTextDisplayComponents(txt("-# Топ — 100 игроков из базы · кнопки раз в минуту"))
    .addActionRowComponents(panelButtons());

  return { components: [container], files, flags: V2 };
}

export function statsCardMessage(view) {
  const live = view.live
    ? `Сейчас на **${view.live.server}** · ${view.live.map || "матч"} · **${view.live.kills}/${view.live.deaths}**`
    : "Статистика с наших серверов WARDOGS RUSSIA.";
  const title = txt(`# ${view.name}`);
  const details = txt(`${live}\n[\`${view.steamId}\`](https://steamcommunity.com/profiles/${view.steamId})`);
  const container = new ContainerBuilder().setAccentColor(COLOR);
  if (view.avatar) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(title, details)
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(view.avatar).setDescription(view.name)),
    );
  } else {
    container.addTextDisplayComponents(title, details);
  }
  return { components: [container], files: [], flags: V2 };
}

export function statsModal() {
  return new ModalBuilder()
    .setCustomId(PANEL_MODAL)
    .setTitle("Статистика игрока")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("query")
          .setLabel("Ник или SteamID64")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("Nomad или 7656119…")
          .setMaxLength(64),
      ),
    );
}

export function statsTextMessage(store, player, view) {
  const extra = store.extras(player.steam_id);
  const faction = extra.factions[0];
  const map = extra.maps[0];
  const mates = extra.mates.map((row) => row.name).join(", ");
  const kills = view?.kills ?? player.kills;
  const deaths = view?.deaths ?? player.deaths;
  const body = [
    `# ${player.name || player.steam_id}`,
    `[\`${player.steam_id}\`](https://steamcommunity.com/profiles/${player.steam_id})`,
    `**${kills}** килов · **${deaths}** смертей · K/D **${formatKd(kills, deaths)}**`,
    `Часов у нас · **${formatHours(player.seconds_played)}**`,
    `Игр / победы · **${view?.games ?? player.matches}** / **${player.wins}**`,
    `Фракция · **${faction?.faction || player.last_faction || "—"}** · карта · **${map?.map || "—"}**`,
    mates ? `Часто играет с · ${mates}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    components: [new ContainerBuilder().setAccentColor(COLOR).addTextDisplayComponents(txt(body))],
    files: [],
    flags: V2,
  };
}

export function topMessage(store, metric = "kills", { fileDir = "", serverId = "", scopeName = "все серверы" } = {}) {
  const saved = fileDir
    ? persistTop100(store, fileDir, { metric, serverId })
    : { rows: store.top(metric, TOP_LIMIT, serverId), file: null };
  const rows = saved.rows;
  if (!rows.length) return null;
  const title = `# Топ ${rows.length} из базы · ${METRIC_LABEL[metric] || metric}`;
  const note = `${scopeName} · ${rows.length} из ${TOP_LIMIT}`;
  const container = new ContainerBuilder()
    .setAccentColor(COLOR)
    .addTextDisplayComponents(txt(title), txt(note));
  const lines = rows.map((row, index) => formatTopLine(row, index, metric));
  const chunks = [];
  let chunk = [];
  let size = 0;
  for (const line of lines) {
    if (chunk.length && size + line.length + 1 > 3500) {
      chunks.push(chunk.join("\n"));
      chunk = [];
      size = 0;
    }
    chunk.push(line);
    size += line.length + 1;
  }
  if (chunk.length) chunks.push(chunk.join("\n"));
  for (const block of chunks.slice(0, 3)) {
    container.addSeparatorComponents(line());
    container.addTextDisplayComponents(txt(block));
  }
  const files = [];
  const csvName = `top100-${metric}.csv`;
  files.push(new AttachmentBuilder(Buffer.from(formatTopCsv(rows, { metric }), "utf8"), { name: csvName }));
  return { components: [container], files, flags: V2 };
}

export function liveMessage(poller, servers) {
  const container = new ContainerBuilder()
    .setAccentColor(COLOR)
    .addTextDisplayComponents(txt("# Онлайн"), txt("Текущий матч на наших серверах"));
  for (const server of servers) {
    const health = poller.health(server.id);
    const state = poller.snapshot(server.id);
    container.addSeparatorComponents(line());
    if (!health.online || !state?.status) {
      container.addTextDisplayComponents(txt(`## ${server.name}\nСервер не отвечает.`));
      continue;
    }
    const status = state.status;
    const top = [...state.roster]
      .sort((a, b) => b.kills - a.kills || b.cash - a.cash)
      .slice(0, 8)
      .map((player, index) => `\`${index + 1}\` **${player.name}** · ${player.kills}/${player.deaths} · +$${player.cashEarned || 0}`)
      .join("\n");
    const scores = (status.factionScores || [])
      .map((row) => `**${row.name}** ${Number(row.score) || 0}`)
      .join("  ·  ");
    const awards = poller.lastAwards?.(server.id);
    const lastAwards = awards
      ? [
          awards.dogi ? `ДОГИ МЕН — **${awards.dogi.name}** · ${awards.dogi.kills} килов` : null,
          awards.miser ? `Скряга — **${awards.miser.name}** · +$${awards.miser.cashEarned || 0}` : null,
        ].filter(Boolean).join(" · ")
      : "";
    container.addTextDisplayComponents(
      txt(
        [
          `## ${status.serverName || server.name}`,
          `${status.map || "—"} · ${prettyMode(status.experiences?.[0])} · **${state.roster.length}/${status.players?.max || "—"}** · ${Math.floor((status.matchSeconds || 0) / 60)}м`,
          scores,
          top ? `Топ матча\n${top}` : "_в ростере пусто_",
          lastAwards ? `Последний завершённый бой · ${lastAwards}` : null,
        ].filter(Boolean).join("\n"),
      ),
    );
  }
  return { components: [container], files: [], flags: V2 };
}

const bumpLock = new Set();
const lastPaint = new Map();

function panelFingerprint(poller, servers, totals) {
  const snaps = (servers || []).map((server) => serverSnapshot(poller, server));
  return JSON.stringify({
    games: totals.games,
    players: totals.players,
    snaps: snaps.map((snap) => ({
      name: snap.name,
      online: snap.online,
      max: snap.max,
      map: snap.map,
      mode: snap.mode,
      matchMin: snap.matchMin,
      awards: snap.awards
        ? {
            dogi: snap.awards.dogi ? `${snap.awards.dogi.steamId}:${snap.awards.dogi.kills}` : "",
            miser: snap.awards.miser ? `${snap.awards.miser.steamId}:${snap.awards.miser.cashEarned || 0}` : "",
          }
        : null,
    })),
  });
}

function isPanelMessage(message, botId) {
  if (!message || message.author?.id !== botId) return false;
  const names = [...message.attachments.values()].map((file) => file.name || "");
  if (names.some((name) => /^panel-\d+\.png$/i.test(name))) return true;
  return Boolean(message.components?.length) && !message.content;
}

export async function removePanel(channel, store) {
  if (!channel) return false;
  bumpLock.add(channel.id);
  try {
    const prev = store.panel(channel.id);
    store.dropPanel(channel.id);
    lastPaint.delete(channel.id);
    const botId = channel.client?.user?.id;
    if (prev?.message_id) {
      await channel.messages.delete(prev.message_id).catch(() => {});
    }
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    let removed = Boolean(prev);
    if (recent && botId) {
      for (const message of recent.values()) {
        if (!isPanelMessage(message, botId)) continue;
        await message.delete().catch(() => {});
        removed = true;
      }
    }
    return removed;
  } finally {
    bumpLock.delete(channel.id);
  }
}

export async function removeAllPanels(client, store) {
  const rows = store.panels();
  let count = 0;
  for (const row of rows) {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (channel) {
      if (await removePanel(channel, store)) count += 1;
    } else {
      store.dropPanel(row.channel_id);
      lastPaint.delete(row.channel_id);
      count += 1;
    }
  }
  return count;
}

export async function placePanel(channel, store, poller, servers) {
  if (!channel || bumpLock.has(channel.id)) return;
  bumpLock.add(channel.id);
  try {
    const prev = store.panel(channel.id);
    if (prev?.message_id) {
      await channel.messages.delete(prev.message_id).catch(() => {});
    }
    const totals = store.totals();
    const sent = await channel.send(await panelMessage(poller, servers, totals));
    store.savePanel(channel.id, sent.id, channel.guildId);
    lastPaint.set(channel.id, panelFingerprint(poller, servers, totals));
    return sent;
  } finally {
    bumpLock.delete(channel.id);
  }
}

export async function refreshPanel(channel, store, poller, servers) {
  if (!channel || bumpLock.has(channel.id)) return;
  const prev = store.panel(channel.id);
  if (!prev?.message_id) return;
  const totals = store.totals();
  const finger = panelFingerprint(poller, servers, totals);
  if (lastPaint.get(channel.id) === finger) return;
  bumpLock.add(channel.id);
  let repost = false;
  try {
    const message = await channel.messages.fetch(prev.message_id).catch(() => null);
    if (!message) {
      if (store.panel(channel.id)) repost = true;
    } else {
      await message.edit(await panelMessage(poller, servers, totals));
      lastPaint.set(channel.id, finger);
    }
  } catch (error) {
    console.warn("panel refresh:", error.message);
    if (store.panel(channel.id) && /Unknown Message|Invalid Form Body/i.test(error.message || "")) repost = true;
  } finally {
    bumpLock.delete(channel.id);
  }
  if (repost && store.panel(channel.id)) await placePanel(channel, store, poller, servers).catch(() => {});
}

export async function refreshAllPanels(client, store, poller, servers) {
  for (const row of store.panels()) {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (channel) await refreshPanel(channel, store, poller, servers);
  }
}

export async function bumpPanel(channel, store, poller, servers) {
  const prev = store.panel(channel.id);
  if (!prev) return;
  const last = channel.lastMessageId;
  if (last && last === prev.message_id) {
    await refreshPanel(channel, store, poller, servers);
    return;
  }
  await placePanel(channel, store, poller, servers);
}
