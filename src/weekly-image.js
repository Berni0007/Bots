import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WIDTH = 1280;
const HEIGHT = 720;
const WEEKLY_TEMPLATE_URL = "https://i.ibb.co/tTkjsFTm/2.jpg";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
let fontConfigReady = false;

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function prepareCyrillicFonts() {
  if (fontConfigReady) return { ok: true, reason: "" };

  const fontDir = resolve(ROOT, "node_modules", "dejavu-fonts-ttf", "ttf");
  const regular = resolve(fontDir, "DejaVuSans.ttf");
  const bold = resolve(fontDir, "DejaVuSans-Bold.ttf");

  if (!existsSync(regular) || !existsSync(bold)) {
    return { ok: false, reason: "dejavu-fonts-ttf не установлен на хосте" };
  }

  try {
    const cacheDir = resolve(ROOT, "data", "fontconfig-cache");
    mkdirSync(cacheDir, { recursive: true });

    const configPath = resolve(ROOT, "data", "zaruba-fonts.conf");
    const xml = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${xmlEscape(fontDir)}</dir>
  <cachedir>${xmlEscape(cacheDir)}</cachedir>
  <match target="pattern">
    <test qual="any" name="family">
      <string>sans-serif</string>
    </test>
    <edit name="family" mode="prepend" binding="strong">
      <string>DejaVu Sans</string>
    </edit>
  </match>
</fontconfig>
`;

    writeFileSync(configPath, xml, "utf8");
    process.env.FONTCONFIG_FILE = configPath;
    fontConfigReady = true;
    return { ok: true, reason: "" };
  } catch (error) {
    return {
      ok: false,
      reason: `fontconfig: ${error instanceof Error ? error.message : error}`,
    };
  }
}

async function fetchTemplate() {
  try {
    const response = await fetch(WEEKLY_TEMPLATE_URL, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "image/*" },
    });
    if (!response.ok) {
      return { ok: false, reason: `шаблон HTTP ${response.status}`, buffer: null };
    }
    const type = response.headers.get("content-type") || "";
    if (!type.startsWith("image/")) {
      return { ok: false, reason: "ссылка шаблона вернула не изображение", buffer: null };
    }
    return {
      ok: true,
      reason: "",
      buffer: Buffer.from(await response.arrayBuffer()),
    };
  } catch (error) {
    return {
      ok: false,
      reason: `шаблон недоступен: ${error instanceof Error ? error.message : error}`,
      buffer: null,
    };
  }
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function kdOf(row) {
  const kills = num(row?.kills);
  const deaths = num(row?.deaths);
  if (deaths > 0) return kills / deaths;
  return kills > 0 ? kills : 0;
}

function money(value) {
  return Math.round(num(value))
    .toLocaleString("ru-RU")
    .replace(/\u00A0/g, " ");
}

function minutes(value) {
  const total = Math.max(0, Math.round(num(value)));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h} ч ${m} мин`;
  if (h) return `${h} ч`;
  return `${m} мин`;
}

function fitSize(value, base, at = 18, min = 18) {
  const len = Array.from(String(value || "")).length;
  if (len <= at) return base;
  return Math.max(min, Math.round((base * at) / len));
}

function nameOf(row) {
  return String(row?.name || row?.steamId || "—");
}

function box(x, y, w, h, radius = 8, opacity = 0.985) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="#121510" fill-opacity="${opacity}"/>`;
}

function centeredText(value, x, y, size, weight = 700, fill = "#f4eee2") {
  return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle"
    font-family="DejaVu Sans, sans-serif" font-size="${size}" font-weight="${weight}"
    fill="${fill}">${esc(value)}</text>`;
}

function leftText(value, x, y, size, weight = 700, fill = "#f4eee2") {
  return `<text x="${x}" y="${y}" dominant-baseline="middle"
    font-family="DejaVu Sans, sans-serif" font-size="${size}" font-weight="${weight}"
    fill="${fill}">${esc(value)}</text>`;
}

// Measure real glyph widths: long and wide names must stay inside their cards.
async function fittedName(sharp, value, width, base, minimum) {
  const clean = String(value).replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 160) || "—";
  async function measure(text, size) {
    const input = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="12000" height="120"><text x="8" y="80" font-family="DejaVu Sans" font-size="${size}" font-weight="700" fill="white">${esc(text)}</text></svg>`);
    const { info } = await sharp(input).trim().toBuffer({ resolveWithObject: true });
    return info.width;
  }
  const measured = await measure(clean, base);
  const size = Math.max(minimum, Math.min(base, Math.floor(base * width / measured)));
  if (measured * size / base <= width) return { value: clean, size };
  const chars = Array.from(clean);
  let low = 0, high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (await measure(chars.slice(0, mid).join("") + "…", size) <= width) low = mid;
    else high = mid - 1;
  }
  return { value: chars.slice(0, low).join("") + "…", size };
}

async function overlayFor(stats, sharp) {
  const leader = stats.leader || null;
  const banker = stats.banker || null;
  const veteran = stats.veteran || null;
  const wins = stats.wins || null;
  const seed = stats.seed || null;
  const seedName = seed ? nameOf(seed) : "Нет данных";
  const names = await Promise.all([
    fittedName(sharp, nameOf(leader), 532, 42, 30),
    fittedName(sharp, nameOf(banker), 236, 28, 23),
    fittedName(sharp, nameOf(veteran), 236, 28, 23),
    fittedName(sharp, nameOf(wins), 288, 28, 23),
  ]);
  const ink = "#f8f4e9";
  const gold = "#d8b778";
  const muted = "#b7bcae";
  const rule = (x, y, w) => `<path d="M${x} ${y}h${w}" stroke="#a58c5e" stroke-opacity=".38"/>`;
  function winner(x, w, name, value, label, size = 31) {
    return `${box(x, 534, w, 101, 5, 1)}
      ${leftText(name.value, x + 10, 554, name.size, 700, ink)}
      ${rule(x + 10, 578, w - 20)}
      ${leftText(value, x + 10, 601, size, 700, gold)}
      ${leftText(label, x + 10, 624, 14, 400, muted)}`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <!-- Unified leader panel, with a large name and two aligned metrics. -->
    ${box(435, 276, 590, 169, 6, 1)}
    ${centeredText("ЛИДЕР СТАИ", 730, 300, 25, 700, gold)}
    ${centeredText(names[0].value, 730, 349, names[0].size, 700, ink)}
    ${rule(465, 381, 530)}
    ${centeredText(leader ? money(leader.kills) : "—", 586, 408, 32, 700, ink)}
    ${centeredText("УБИЙСТВА", 586, 436, 13, 700, muted)}
    ${centeredText(leader ? kdOf(leader).toFixed(2) : "—", 875, 408, 32, 700, ink)}
    ${centeredText("K/D", 875, 436, 13, 700, muted)}
    ${winner(48, 256, names[1], banker ? money(banker.cash) : "—", "ЗАРАБОТАНО", 28)}
    ${winner(350, 256, names[2], veteran ? minutes(veteran.minutes) : "—", "ВРЕМЯ В ИГРЕ", 26)}
    ${winner(651, 308, names[3], wins ? `${num(wins.wins)} / ${num(wins.matches)}` : "—", "ПОБЕДЫ / МАТЧИ")}

    <!-- SEED-БОЕЦ -->
    ${box(1000, 545, 231, 28, 4)}
    ${leftText(seedName, 1008, 559, fitSize(seedName, 21, 17, 15), 700)}

    ${box(1120, 598, 111, 26, 4)}
    ${centeredText(seed ? minutes(seed.seedMinutes) : "—", 1175, 611, 16, 700)}
  </svg>`;
}

export async function renderWeeklyImage(stats) {
  const fonts = prepareCyrillicFonts();
  if (!fonts.ok) {
    return { ok: false, reason: fonts.reason, buffer: null };
  }

  let sharp;
  try {
    const mod = await import("sharp");
    sharp = mod.default || mod;
  } catch (error) {
    return {
      ok: false,
      reason: `sharp недоступен: ${error instanceof Error ? error.message : error}`,
      buffer: null,
    };
  }

  const template = await fetchTemplate();
  if (!template.ok || !template.buffer) {
    return { ok: false, reason: template.reason, buffer: null };
  }

  try {
    const base = await sharp(template.buffer)
      .resize(WIDTH, HEIGHT, { fit: "fill" })
      .png()
      .toBuffer();

    const overlay = Buffer.from(await overlayFor(stats, sharp), "utf8");

    const buffer = await sharp(base)
      .composite([{ input: overlay, top: 0, left: 0 }])
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();

    return { ok: true, reason: "", buffer };
  } catch (error) {
    return {
      ok: false,
      reason: `рендер изображения: ${error instanceof Error ? error.message : error}`,
      buffer: null,
    };
  }
}

