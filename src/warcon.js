import { config } from "./config.js";

function baseUrl() {
  return String(config.warconBaseUrl || "").replace(/\/$/, "");
}

async function api(path) {
  if (!config.warconApiKey || !baseUrl()) return null;
  const response = await fetch(`${baseUrl()}${path}`, {
    headers: {
      Authorization: `Bearer ${config.warconApiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`Warcon ${response.status} ${path}`);
  }
  return response.json();
}

let cachedServerId = "";
let cachedAt = 0;

export async function resolveWarconServerId() {
  if (config.warconServerId) return String(config.warconServerId);
  if (cachedServerId && Date.now() - cachedAt < 10 * 60 * 1000) return cachedServerId;

  const data = await api("/api/servers");
  const servers = data?.servers || [];
  if (!servers.length) return "";

  const wanted = String(config.servers?.[0]?.name || "").trim().toLowerCase();
  const exact = servers.find((s) => String(s.name || "").trim().toLowerCase() === wanted);
  const picked = exact || servers[0];

  cachedServerId = String(picked?.id || "");
  cachedAt = Date.now();
  return cachedServerId;
}

export async function fetchWarconCareer(steamId) {
  if (!/^7656119\d{10}$/.test(String(steamId || ""))) return null;
  const serverId = await resolveWarconServerId();
  if (!serverId) return null;

  const [careerData, dossierData] = await Promise.all([
    api(`/api/servers/${encodeURIComponent(serverId)}/players/${steamId}/career`),
    api(`/api/servers/${encodeURIComponent(serverId)}/players/${steamId}`),
  ]);

  return {
    serverId,
    career: careerData?.career || null,
    dossier: dossierData?.dossier || null,
  };
}
