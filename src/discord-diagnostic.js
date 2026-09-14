import { REST, Routes } from "discord.js";

function describeError(error) {
  const parts = [error?.message];
  if (error?.code) parts.push(`code=${error.code}`);
  if (error?.status) parts.push(`status=${error.status}`);
  return parts.filter(Boolean).join(" · ") || String(error);
}

async function cleanup(rest, channelId, messageId, label) {
  if (!messageId) return;
  try {
    await rest.delete(Routes.channelMessage(channelId, messageId));
    console.log(`discord diag: ${label} test message deleted`);
  } catch (error) {
    console.warn(`discord diag: ${label} delete failed:`, describeError(error));
  }
}

async function inspectChannel(rest, label, channelId) {
  if (!channelId) {
    console.warn(`discord diag: ${label} channel id is empty`);
    return null;
  }

  try {
    const channel = await rest.get(Routes.channel(channelId));
    console.log(
      `discord diag: ${label} id=${channelId} name=#${channel?.name || "?"} type=${channel?.type ?? "?"} guild=${channel?.guild_id || "?"} parent=${channel?.parent_id || "none"}`,
    );
    return channel;
  } catch (error) {
    console.warn(`discord diag: ${label} GET failed [${channelId}]:`, describeError(error));
    return null;
  }
}

async function testResultsChannel(rest, channelId) {
  if (!channelId) return;

  let plain = null;
  try {
    plain = await rest.post(Routes.channelMessages(channelId), {
      body: { content: "ZARUBA STATS · проверка доступа к каналу итогов" },
    });
    console.log(`discord diag: results plain message OK -> ${channelId}`);
  } catch (error) {
    console.warn(`discord diag: results plain message FAILED [${channelId}]:`, describeError(error));
    return;
  } finally {
    if (plain?.id) await cleanup(rest, channelId, String(plain.id), "plain");
  }

  let embed = null;
  try {
    embed = await rest.post(Routes.channelMessages(channelId), {
      body: {
        embeds: [
          {
            title: "ZARUBA STATS",
            description: "Проверка права «Встраивать ссылки»",
            color: 0xe8a317,
          },
        ],
      },
    });
    console.log(`discord diag: results embed OK -> ${channelId}`);
  } catch (error) {
    console.warn(`discord diag: results embed FAILED [${channelId}]:`, describeError(error));
  } finally {
    if (embed?.id) await cleanup(rest, channelId, String(embed.id), "embed");
  }
}

export async function diagnoseDiscordChannels({ token, liveChannelId, resultsChannelId }) {
  if (!token) return;
  const rest = new REST({ version: "10" }).setToken(token);

  console.log(`discord diag: live=${liveChannelId || "—"} results=${resultsChannelId || "—"}`);
  await inspectChannel(rest, "live", liveChannelId);
  await inspectChannel(rest, "results", resultsChannelId);
  await testResultsChannel(rest, resultsChannelId);
}
