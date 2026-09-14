import { Agent, fetch as undiciFetch } from "undici";

const insecure = new Agent({
  connect: { rejectUnauthorized: false },
});

const schemeCache = new Map();

function cacheKey(server) {
  return `${server.host}:${server.port}`;
}

function errorDetail(text) {
  if (!text) return "";
  try {
    const body = JSON.parse(text);
    return body?.error?.message || body?.error?.code || text.slice(0, 160);
  } catch {
    return text.slice(0, 160);
  }
}

async function request(server, path, scheme, timeoutMs, options = {}) {
  const { method = "GET", body, raw, headers = {} } = options;
  const payload = raw != null ? raw : body != null ? JSON.stringify(body) : undefined;
  const url = `${scheme}://${server.host}:${server.port}${path}`;
  const response = await undiciFetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${server.password}`,
      ...(payload != null && raw == null ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: scheme === "https" ? insecure : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = errorDetail(text);
    throw new Error(`RCON ${response.status} ${method} ${path}${detail ? `: ${detail}` : ""}`);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export async function rconCall(server, path, options = {}) {
  const key = cacheKey(server);
  const preferred = schemeCache.get(key) || (server.tls ? "https" : "http");
  const order = preferred === "https" ? ["https", "http"] : ["http", "https"];
  let lastError;
  for (const scheme of order) {
    try {
      const body = await request(server, path, scheme, options.timeoutMs || 8000, options);
      schemeCache.set(key, scheme);
      return body;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function rconGet(server, path, timeoutMs = 8000) {
  return rconCall(server, path, { method: "GET", timeoutMs });
}

export async function fetchSnapshot(server) {
  const [status, playersBody] = await Promise.all([
    rconGet(server, "/v1/status"),
    rconGet(server, "/v1/players"),
  ]);
  return {
    status,
    players: Array.isArray(playersBody?.players) ? playersBody.players : [],
  };
}
