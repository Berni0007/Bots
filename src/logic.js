export const MATCH_WIN_SCORE = 100;

export function isSteamId64(id) {
  return /^7656119\d{10}$/.test(String(id || "").trim());
}

export function normalizePlayer(raw) {
  return {
    steamId: String(raw?.steamId || "").trim(),
    name: String(raw?.name || "игрок").trim().slice(0, 64) || "игрок",
    faction: String(raw?.faction || "").trim().slice(0, 32),
    kills: Math.max(0, Number(raw?.kills) || 0),
    deaths: Math.max(0, Number(raw?.deaths) || 0),
    cash: Math.max(0, Number(raw?.cash) || 0),
    pingMs: Math.max(0, Number(raw?.pingMs) || 0),
  };
}

export function detectMatchReset(prev, next) {
  if (!prev || !next) return false;
  if (prev.map && next.map && prev.map !== next.map) return true;
  const a = Number(prev.matchSeconds) || 0;
  const b = Number(next.matchSeconds) || 0;
  return a >= 45 && b < 40 && b + 20 < a;
}

function maxFactionScore(status) {
  return Math.max(
    0,
    ...(status?.factionScores || []).map((row) => Number(row?.score) || 0),
  );
}

export function detectScoreWin(status) {
  return maxFactionScore(status) >= MATCH_WIN_SCORE;
}

export function detectScoreReset(prev, next) {
  if (!prev || !next) return false;
  const before = maxFactionScore(prev);
  const after = maxFactionScore(next);
  return before >= 10 && after <= 4 && after < before * 0.35;
}

export function detectKillReset(held, incoming) {
  const prevKills = (held || []).reduce((sum, row) => sum + (Number(row.kills) || 0), 0);
  const nextKills = (incoming || []).reduce((sum, row) => sum + (Number(row.kills) || 0), 0);
  return incoming.length >= 2 && prevKills >= 10 && nextKills <= 4 && nextKills < prevKills * 0.35;
}

export function winningFactions(factionScores) {
  const rows = (factionScores || []).map((row) => ({
    name: String(row?.name || "").trim(),
    score: Number(row?.score) || 0,
  }));
  if (!rows.length) return [];
  const max = Math.max(...rows.map((row) => row.score));
  if (max <= 0) return [];
  return rows.filter((row) => row.name && row.score === max).map((row) => row.name);
}

export function capDeltaMs(deltaMs, pollMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return 0;
  return Math.min(deltaMs, Math.max(pollMs, 1000) * 4);
}

export function kd(kills, deaths) {
  const k = Number(kills) || 0;
  const d = Number(deaths) || 0;
  if (d === 0) return k > 0 ? k : 0;
  return k / d;
}

export function formatHours(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h <= 0) return `${m}м`;
  return `${h}ч ${m}м`;
}

export function formatKd(kills, deaths) {
  return kd(kills, deaths).toFixed(2);
}

export function matchAwards(snapshots) {
  const rows = (snapshots || []).filter((row) => row?.steamId);
  const dogi = [...rows]
    .filter((row) => (Number(row.kills) || 0) > 0)
    .sort((a, b) =>
      (Number(b.kills) || 0) - (Number(a.kills) || 0) ||
      (Number(a.deaths) || 0) - (Number(b.deaths) || 0) ||
      (Number(b.cashEarned) || 0) - (Number(a.cashEarned) || 0)
    )[0] || null;
  const miser = [...rows]
    .filter((row) => (Number(row.cashEarned) || 0) > 0)
    .sort((a, b) =>
      (Number(b.cashEarned) || 0) - (Number(a.cashEarned) || 0) ||
      (Number(b.kills) || 0) - (Number(a.kills) || 0)
    )[0] || null;
  return { dogi, miser };
}

export function prettyMode(experience) {
  const raw = String(experience || "");
  const match = raw.match(/koth|tdm|dm|frontline|conquest/i);
  if (match) return match[0].toUpperCase();
  return raw.replaceAll("_", " ") || "—";
}

export function applyTick(state, input) {
  const now = input.now;
  const pollMs = input.pollMs;
  const players = (input.players || [])
    .map(normalizePlayer)
    .filter((player) => isSteamId64(player.steamId));
  const status = input.status || {};
  const byId = new Map(players.map((player) => [player.steamId, player]));
  const prevIds = new Set(state.online.keys());
  const events = [];

  const matchBoundary =
    detectMatchReset(state.status, status) ||
    detectScoreReset(state.status, status) ||
    detectKillReset([...state.match.bySteam.values()], players);

  if (matchBoundary) {
    if (!state.match.ended && state.match.bySteam.size) {
      events.push({
        type: "match_end",
        winners: winningFactions(state.status?.factionScores),
        map: state.status?.map || state.match.map || "",
        mode: prettyMode(state.status?.experiences?.[0]) || state.match.mode,
        startedAt: state.match.startedAt,
        snapshots: [...state.match.bySteam.values()],
      });
    }
    state.match = newMatch(now, status);
  }

  if (!state.match.startedAt) {
    state.match = newMatch(now, status);
  } else {
    state.match.map = status.map || state.match.map;
    state.match.mode = prettyMode(status.experiences?.[0]) || state.match.mode;
  }

  const delta = state.lastTick
    ? capDeltaMs(now - state.lastTick, pollMs)
    : 0;

  for (const player of players) {
    if (!state.online.has(player.steamId)) {
      events.push({ type: "join", player, at: now });
      state.online.set(player.steamId, { joinedAt: now, lastSeen: now });
    } else {
      const session = state.online.get(player.steamId);
      session.lastSeen = now;
      if (delta > 0) {
        events.push({ type: "tick_time", steamId: player.steamId, ms: delta });
      }
    }

    const existing = state.match.bySteam.get(player.steamId);
    if (state.match.ended) {
      player.cashEarned = Number(existing?.cashEarned) || 0;
      continue;
    }

    const snap = existing || {
      steamId: player.steamId,
      name: player.name,
      faction: player.faction,
      kills: 0,
      deaths: 0,
      cashEnd: 0,
      cashPeak: 0,
      cashLast: null,
      cashEarned: 0,
    };
    snap.name = player.name;
    snap.faction = player.faction;
    snap.kills = player.kills;
    snap.deaths = player.deaths;
    if (snap.cashLast != null && player.cash > snap.cashLast) {
      snap.cashEarned += player.cash - snap.cashLast;
    }
    snap.cashLast = player.cash;
    snap.cashEnd = player.cash;
    snap.cashPeak = Math.max(snap.cashPeak, player.cash);
    player.cashEarned = snap.cashEarned;
    state.match.bySteam.set(player.steamId, snap);
  }

  // WARDOGS KOTH ends the moment a faction reaches 100 points. Real live
  // RCON builds can omit matchSeconds/scoreCap, so this is the reliable
  // immediate end-of-match signal instead of waiting for the next map load.
  if (!state.match.ended && detectScoreWin(status) && state.match.bySteam.size) {
    state.match.ended = true;
    state.match.endedAt = now;
    events.push({
      type: "match_end",
      winners: winningFactions(status.factionScores),
      map: status.map || state.match.map || "",
      mode: prettyMode(status.experiences?.[0]) || state.match.mode,
      startedAt: state.match.startedAt,
      snapshots: [...state.match.bySteam.values()],
    });
  }

  for (const steamId of prevIds) {
    if (byId.has(steamId)) continue;
    events.push({ type: "leave", steamId, at: now });
    state.online.delete(steamId);
  }

  state.status = {
    serverName: status.serverName || "",
    map: status.map || "",
    experiences: status.experiences || [],
    matchSeconds: Number(status.matchSeconds) || 0,
    lighting: status.lighting || "",
    factionScores: status.factionScores || [],
    players: status.players || { current: players.length, max: 0 },
  };
  state.roster = players;
  state.lastTick = now;
  return { state, events };
}

export function emptyState() {
  return {
    online: new Map(),
    roster: [],
    status: null,
    lastTick: 0,
    match: newMatch(0, {}),
  };
}

function newMatch(now, status) {
  return {
    startedAt: now,
    ended: false,
    endedAt: 0,
    map: status.map || "",
    mode: prettyMode(status.experiences?.[0]),
    bySteam: new Map(),
  };
}
