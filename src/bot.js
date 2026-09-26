import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { config } from "./config.js";
import { fetchCommunityProfile, resolveSteamInput } from "./steam.js";
import { Cooldown } from "./cooldown.js";
import { resolveSteamId } from "./lookup.js";
import { buildView } from "./view.js";
import { fetchWarconCareer } from "./warcon.js";
import {
  dogCardMessage,
  seedPanelMessage,
  seedResultMessage,
  SEED_JOIN,
  SEED_USE_SAVED,
  SEED_OTHER,
  SEED_MODAL,
  seedSavedSteamMessage,
  seedSteamModal,
} from "./panel.js";
const usageCd = new Cooldown(60_000);
const DOG_CHANNEL_ID = "1553370010158759969";

export function buildCommands() {
  const dog = new SlashCommandBuilder()
    .setName("dog")
    .setDescription("Личное боевое досье WARDOGS")
    .addStringOption((option) =>
      option
        .setName("ник")
        .setDescription("Ник или SteamID64")
        .setAutocomplete(true),
    );


  const seedPanel = new SlashCommandBuilder()
    .setName("seed-panel")
    .setDescription("Разместить постоянную панель SEED в этом канале")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  return [dog, seedPanel];
}

async function publishSeedPanel(client, store, poller, servers) {
  const channelId = String(config.seedChannelId || "").trim();
  if (!channelId) return;

  console.log("seed: target channel", channelId);
  const channel = await client.channels.fetch(channelId).catch((error) => {
    console.warn("seed: fetch channel failed:", error.message);
    return null;
  });
  if (!channel?.isTextBased() || typeof channel.send !== "function") {
    console.warn("seed: канал недоступен", channelId);
    return;
  }

  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = recent?.find(
    (message) =>
      message.author?.id === client.user.id &&
      (
        message.embeds?.some((embed) =>
          ["SEED ZARUBA", "СОБИРАЕМ СТАЮ"].includes(embed.title),
        ) ||
        message.components?.some((row) =>
          row.components?.some((component) => component.customId === SEED_JOIN),
        )
      ),
  );

  const payload = seedPanelMessage(config.seedThreshold);
  if (existing) {
    await existing.edit(payload).catch(() => {});
  } else {
    await channel.send(payload);
  }

  poller.onSeedComplete = async (result) => {
    const target = await client.channels.fetch(channelId).catch(() => null);
    if (!target?.isTextBased() || typeof target.send !== "function") return;
    await target.send(seedResultMessage(result));
  };
}


function seedServerState(poller, servers) {
  const server = servers[0];
  if (!server) return { server: null, online: 0 };
  const state = poller.snapshot(server.id);
  const online = Math.max(
    state?.roster?.length || 0,
    Number(state?.status?.players?.current) || 0,
  );
  return { server, online };
}

async function enrollSeed(interaction, store, poller, servers, steamId) {
  const channelId = String(config.seedChannelId || "").trim();
  const { server, online } = seedServerState(poller, servers);

  if (!channelId || interaction.channelId !== channelId) {
    const payload = {
      content: channelId ? `SEED работает только в <#${channelId}>.` : "Канал SEED ещё не настроен.",
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
    return false;
  }

  if (!server) {
    const payload = { content: "Сервер WARDOGS не настроен.", flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
    return false;
  }

  if (online > config.seedThreshold) {
    const payload = {
      content: `SEED уже завершён: на сервере ${online} игроков.`,
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
    return false;
  }

  store.link(interaction.user.id, steamId, Date.now());
  const round = store.ensureSeedRound(server.id, config.seedThreshold, Date.now());
  store.joinSeed(round.id, interaction.user.id, steamId, Date.now());

  const payload = {
    content:
      `Ты записан в текущий SEED. SteamID: \`${steamId}\`.\n` +
      "Награда будет засчитана, когда бот увидит этот SteamID на сервере до завершения SEED.",
    flags: MessageFlags.Ephemeral,
  };
  if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
  else await interaction.reply(payload);
  return true;
}

async function handleSeedJoin(interaction, store, poller, servers) {
  const channelId = String(config.seedChannelId || "").trim();
  if (!channelId || interaction.channelId !== channelId) {
    await interaction.reply({
      content: channelId ? `SEED работает только в <#${channelId}>.` : "Канал SEED ещё не настроен.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { online } = seedServerState(poller, servers);
  if (online > config.seedThreshold) {
    await interaction.reply({
      content: `SEED уже завершён: на сервере ${online} игроков.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const link = store.linkForDiscord(interaction.user.id);
  if (link?.steam_id) {
    await interaction.reply(seedSavedSteamMessage(link.steam_id));
    return;
  }

  await interaction.showModal(seedSteamModal());
}

async function handleSeedUseSaved(interaction, store, poller, servers) {
  const link = store.linkForDiscord(interaction.user.id);
  if (!link?.steam_id) {
    await interaction.reply({
      content: "Сохранённый SteamID не найден. Нажми «Указать другой».",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await enrollSeed(interaction, store, poller, servers, link.steam_id);
}

async function handleSeedOther(interaction) {
  await interaction.showModal(seedSteamModal());
}

async function handleSeedModal(interaction, store, poller, servers) {
  const raw = interaction.fields.getTextInputValue("steam");
  let steamId = null;
  try {
    steamId = await resolveSteamInput(config.steamApiKey, raw);
  } catch (error) {
    console.warn("seed steam resolve:", error.message);
  }

  if (!steamId) {
    await interaction.reply({
      content:
        "Не удалось определить SteamID64. Вставь SteamID64 или ссылку вида steamcommunity.com/profiles/... / steamcommunity.com/id/....",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await enrollSeed(interaction, store, poller, servers, steamId);
}

export async function startBot({ token, clientId, guildId, store, poller, servers }) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    allowedMentions: { parse: ["users"] },
  });
  const allowed = { id: guildId || "" };

  client.once(Events.ClientReady, async (ready) => {
    console.log(`discord: ${ready.user.tag}`);
    ready.user.setActivity("считаю игроков…", { type: ActivityType.Watching });
    const rest = new REST({ version: "10" }).setToken(token);
    const body = buildCommands(servers).map((command) => command.toJSON());
    const appId = ready.application?.id || clientId || ready.user.id;
    await ready.guilds.fetch().catch(() => {});
    const guilds = [...ready.guilds.cache.values()];
    console.log(
      "discord: вижу серверы:",
      guilds.map((guild) => `${guild.name} (${guild.id})`).join(", ") || "ни одного",
    );

    try {
      await rest.put(Routes.applicationCommands(appId), { body: [] });
    } catch (error) {
      console.warn("discord: не снял глобальные команды:", error.message);
    }

    const targets = [];
    if (allowed.id) targets.push(allowed.id);
    for (const guild of guilds) {
      if (!targets.includes(guild.id)) targets.push(guild.id);
    }

    for (const id of targets) {
      try {
        await rest.put(Routes.applicationGuildCommands(appId, id), { body });
        console.log(`discord: команды на ${id}`);
      } catch (error) {
        console.warn(`discord: команды не встали на ${id}:`, error.message);
      }
    }

    const pushActivity = () => refreshActivity(ready, poller, servers);
    pushActivity();
    setInterval(pushActivity, 10_000);
    poller.onTick = () => {
      pushActivity();
    };

    const ensureSeedPanel = async () => {
      try {
        await publishSeedPanel(ready, store, poller, servers);
      } catch (error) {
        console.warn("seed panel:", error.message);
      }
    };

    await ensureSeedPanel();
    setInterval(() => void ensureSeedPanel(), 60_000);

  });

  client.on(Events.GuildDelete, (guild) => {
    console.warn(`discord: сняли с сервера ${guild.name || "?"} (${guild.id})`);
  });

  client.on(Events.GuildCreate, async (guild) => {
    console.log(`discord: добавили на ${guild.name} (${guild.id})`);
    if (allowed.id && guild.id !== allowed.id) {
      console.warn(`discord: жду сервер ${allowed.id}, это другой — команды всё равно ставлю`);
    }
    const rest = new REST({ version: "10" }).setToken(token);
    const body = buildCommands(servers).map((command) => command.toJSON());
    const appId = client.application?.id || clientId;
    try {
      await rest.put(Routes.applicationGuildCommands(appId, guild.id), { body });
      allowed.id = guild.id;
      console.log(`discord: команды на ${guild.id}`);
    } catch (error) {
      console.warn(`discord: команды не встали на ${guild.id}:`, error.message);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (allowed.id && interaction.guildId && interaction.guildId !== allowed.id) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: "Этот бот работает только на основном сервере.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
    try {
      if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused();
        const rows = store.suggestPlayers(focused);
        await interaction.respond(
          rows.slice(0, 25).map((row) => ({
            name: `${row.name} · ${row.kills} килов`.slice(0, 100),
            value: row.steam_id,
          })),
        );
        return;
      }
      if (interaction.isButton() && interaction.customId === SEED_JOIN) {
        await handleSeedJoin(interaction, store, poller, servers);
        return;
      }
      if (interaction.isButton() && interaction.customId === SEED_USE_SAVED) {
        await handleSeedUseSaved(interaction, store, poller, servers);
        return;
      }
      if (interaction.isButton() && interaction.customId === SEED_OTHER) {
        await handleSeedOther(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId === SEED_MODAL) {
        await handleSeedModal(interaction, store, poller, servers);
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName === "dog") {
        if (await denyCooldown(interaction)) return;
        if (await cmdDog(interaction, store, poller, servers)) usageCd.hit(interaction.user.id);
      } else if (interaction.commandName === "seed-panel") {
        if (interaction.channelId !== String(config.seedChannelId || "").trim()) {
          await interaction.reply({
            content: `Эту панель ставим только в <#${config.seedChannelId}>.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        try {
          await interaction.reply(seedPanelMessage(config.seedThreshold));
        } catch (error) {
          console.error("seed-panel interaction reply:", error);
          const code = error?.code ? ` code=${error.code}` : "";
          const status = error?.status ? ` status=${error.status}` : "";
          await interaction.reply({
            content: `Не смог вывести SEED-панель: ${error.message}${code}${status}`,
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
        }
        return;
      }
    } catch (error) {
      console.error("command", interaction.commandName || interaction.customId, error);
      const text = "Не получилось ответить. Попробуй ещё раз.";
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral }).catch(() => {});
      else if (interaction.isRepliable()) await interaction.reply({ content: text, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  await client.login(token);
  return client;
}

function serverOnline(poller, server) {
  const state = poller.snapshot(server.id);
  const roster = state?.roster?.length || 0;
  const reported = Number(state?.status?.players?.current) || 0;
  return Math.max(roster, reported);
}

function refreshActivity(client, poller, servers) {
  const counts = servers.map((server) => serverOnline(poller, server));
  if (!counts.some((n) => n > 0) && !servers.some((server) => poller.health(server.id).online)) {
    client.user.setActivity("серверы молчат · /stats", { type: ActivityType.Watching });
    return;
  }
  const total = counts.reduce((sum, n) => sum + n, 0);
  const byServer = counts.map((n, i) => `#${servers[i].id} ${n}`).join(" · ");
  client.user.setActivity(`${total} онлайн · ${byServer}`, { type: ActivityType.Watching });
}

async function denyCooldown(interaction) {
  const left = usageCd.remaining(interaction.user.id);
  if (left <= 0) return false;
  await interaction.reply({
    content: `Подожди ${Math.ceil(left / 1000)}с — статистика и кнопки раз в минуту.`,
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

async function acknowledge(interaction) {
  if (interaction.deferred || interaction.replied) return;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (error) {
    if (error.code !== 10062) throw error;
  }
}

async function sendPayload(send, payload, fallbackText) {
  try {
    await send(payload);
    return true;
  } catch (error) {
    if (error.code !== 50035) throw error;
    await send({
      content: fallbackText || "Список во вложении.",
      files: payload.files,
    });
    return true;
  }
}

async function replyPrivate(interaction, payload, ack) {
  await acknowledge(interaction);
  if (!interaction.guildId) {
    await sendPayload((body) => interaction.followUp(body), payload, ack);
    return true;
  }
  try {
    await sendPayload((body) => interaction.user.send(body), payload, ack);
    await interaction.editReply({ content: ack || "Отправил в личку." });
    return true;
  } catch {
    await interaction.editReply({ content: "ЛС закрыты — статистика ниже, только ты видишь." });
    await sendPayload(
      (body) =>
        interaction.followUp({
          ...body,
          flags: body.components?.length
            ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
            : MessageFlags.Ephemeral,
        }),
      payload,
      ack,
    );
    return true;
  }
}

async function replyStats(interaction, store, poller, servers, raw) {
  await acknowledge(interaction);
  const found = resolveSteamId(store, interaction, raw);
  if (!found.steamId) {
    await interaction.editReply({ content: found.note });
    return false;
  }
  const player = store.player(found.steamId);
  if (!player) {
    await interaction.editReply({ content: `В базе нет \`${found.steamId}\`.` });
    return false;
  }
  const view = buildView(store, poller, servers, player);
  if (!view.avatar) {
    try {
      const profile = await fetchCommunityProfile(player.steam_id);
      if (profile?.avatar) {
        store.updateAvatar(player.steam_id, profile.avatar, Date.now());
        view.avatar = profile.avatar;
      }
    } catch (error) {
      console.warn("steam avatar:", error.message);
    }
  }
  const own = store.linkForDiscord(interaction.user.id);
  if (!view.avatar && own?.steam_id === player.steam_id) {
    view.avatar = interaction.user.displayAvatarURL({ extension: "png", size: 256, forceStatic: true });
  }
  let payload;
  try {
    payload = statsCardMessage(view);
  } catch (error) {
    console.warn("stats view:", error.message);
    payload = statsTextMessage(store, player, view);
  }
  return replyPrivate(interaction, payload, `Статистика **${view.name}** в личке.`);
}


async function cmdDog(interaction, store, poller, servers) {
  if (interaction.channelId !== DOG_CHANNEL_ID) {
    await interaction.reply({
      content: `Команда /dog работает только в <#${DOG_CHANNEL_ID}>.`,
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  const raw = interaction.options.getString("ник") || "";
  const found = resolveSteamId(store, interaction, raw);
  if (!found.steamId) {
    await interaction.reply({
      content: found.note || "Игрок не найден.",
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  const player = store.player(found.steamId);
  if (!player) {
    await interaction.reply({
      content: `В базе нет \`${found.steamId}\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  const view = buildView(store, poller, servers, player);
  view.bannerUrl = config.dogBannerUrl || "";

  if (config.warconApiKey) {
    try {
      const warcon = await fetchWarconCareer(player.steam_id);
      const career = warcon?.career;
      if (career) {
        view.warcon = true;
        view.careerKills = Number(career.kills) || 0;
        view.careerDeaths = Number(career.deaths) || 0;
        view.careerKd = view.careerDeaths > 0
          ? (view.careerKills / view.careerDeaths).toFixed(2)
          : view.careerKills > 0 ? String(view.careerKills) : "0.00";
        view.matches = Number(career.matches) || 0;
        view.wins = Number(career.wins) || 0;
        view.winrate = view.matches > 0 ? Math.round((view.wins / view.matches) * 100) : 0;
        view.hours = `${Math.floor((Number(career.minutes) || 0) / 60)} ч ${Math.round((Number(career.minutes) || 0) % 60)} мин`;
        view.headshots = Number(career.headshots) || 0;
        view.vehicleKills = Number(career.vehicleKills) || 0;
        view.longestM = career.longestM == null ? null : Number(career.longestM);
        view.killStreak = Number(career.killStreak) || 0;
        view.zarubaRank = career.rank?.org ?? career.rank?.server ?? null;
      }
      if (!view.avatar && warcon?.dossier?.steam?.avatar) {
        view.avatar = warcon.dossier.steam.avatar;
      }
    } catch (error) {
      console.warn("warcon /dog:", error.message);
    }
  }

  if (!view.avatar) {
    try {
      const profile = await fetchCommunityProfile(player.steam_id);
      if (profile?.avatar) {
        store.updateAvatar(player.steam_id, profile.avatar, Date.now());
        view.avatar = profile.avatar;
      }
    } catch (error) {
      console.warn("steam avatar /dog:", error.message);
    }
  }

  if (!view.avatar) {
    const own = store.linkForDiscord(interaction.user.id);
    if (own?.steam_id === player.steam_id) {
      view.avatar = interaction.user.displayAvatarURL({ extension: "png", size: 256, forceStatic: true });
    }
  }

  await interaction.reply(dogCardMessage(view));
  return true;
}

