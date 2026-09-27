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

function box(x, y, w, h, radius = 8) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="#121510" fill-opacity="0.985"/>`;
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

function overlayFor(stats) {
  const leader = stats.leader || null;
  const banker = stats.banker || null;
  const veteran = stats.veteran || null;
  const wins = stats.wins || null;
  const seed = stats.seed || null;

  const leaderName = nameOf(leader);
  const bankerName = nameOf(banker);
  const veteranName = nameOf(veteran);
  const winsName = nameOf(wins);
  const seedName = seed ? nameOf(seed) : "Нет данных";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <!-- ЛИДЕР СТАИ -->
    ${box(452, 339, 548, 40, 5)}
    ${leftText(leaderName, 470, 359, fitSize(leaderName, 31, 24, 20), 700)}

    ${box(590, 407, 88, 28, 4)}
    ${centeredText(leader ? String(num(leader.kills)) : "—", 634, 421, 24, 700)}

    ${box(871, 407, 126, 28, 4)}
    ${centeredText(leader ? kdOf(leader).toFixed(2) : "—", 934, 421, 24, 700)}

    <!-- БАНКИР -->
    ${box(54, 545, 232, 28, 4)}
    ${leftText(bankerName, 62, 559, fitSize(bankerName, 22, 18, 16), 700)}

    ${box(182, 598, 107, 26, 4)}
    ${centeredText(banker ? money(banker.cash) : "—", 235, 611, 18, 700)}

    <!-- ВЕТЕРАН НЕДЕЛИ -->
    ${box(354, 545, 237, 28, 4)}
    ${leftText(veteranName, 363, 559, fitSize(veteranName, 22, 18, 16), 700)}

    ${box(500, 598, 92, 26, 4)}
    ${centeredText(veteran ? minutes(veteran.minutes) : "—", 546, 611, 16, 700)}

    <!-- ЛИДЕР ПО ПОБЕДАМ -->
    ${box(651, 545, 286, 28, 4)}
    ${leftText(winsName, 660, 559, fitSize(winsName, 22, 20, 16), 700)}

    ${box(735, 598, 53, 26, 4)}
    ${centeredText(wins ? String(num(wins.wins)) : "—", 761, 611, 17, 700)}

    ${box(892, 598, 51, 26, 4)}
    ${centeredText(wins ? String(num(wins.matches)) : "—", 917, 611, 17, 700)}

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

    const overlay = Buffer.from(overlayFor(stats), "utf8");

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
