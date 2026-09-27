import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WIDTH = 1672;
const HEIGHT = 941;

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
    return { ok: true, reason: "", buffer: readFileSync(resolve(HERE, "assets", "weekly-template.jpg")) };
  } catch (error) {
    return { ok: false, reason: `локальный шаблон: ${error.message}`, buffer: null };
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

function counted(value, forms) {
  const n = Math.abs(Math.round(num(value)));
  const form = n % 100 >= 11 && n % 100 <= 14 ? forms[2]
    : n % 10 === 1 ? forms[0] : n % 10 >= 2 && n % 10 <= 4 ? forms[1] : forms[2];
  return `${money(value)} ${form}`;
}

function minutes(value) {
  const total = Math.max(0, Math.round(num(value)));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h} ч ${m} мин`;
  if (h) return `${h} ч`;
  return `${m} мин`;
}

function nameOf(row) {
  return String(row?.name || row?.steamId || "—");
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
    const input = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="18000" height="180"><text x="8" y="130" font-family="DejaVu Sans" font-size="${size}" font-weight="700" fill="white">${esc(text)}</text></svg>`);
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

// Coordinates match the bundled 1672 x 941 template; no external image host.
async function overlayFor(stats, sharp) {
  const parts = [];
  async function text(value, x, y, width, base, minimum = base) {
    const fit = await fittedName(sharp, value, width - 10, base, minimum);
    parts.push(leftText(fit.value, x, y, fit.size));
  }
  const { leader, banker, veteran, wins, seed } = stats;
  await text(leader ? nameOf(leader) : "Нет данных", 90, 405, 750, 88, 38);
  await text(leader ? money(leader.kills) : "—", 160, 487, 156, 49, 24);
  await text(leader ? kdOf(leader).toFixed(2) : "—", 676, 487, 156, 49, 24);
  for (const [row, x, y, result] of [
    [banker, 170, 605, banker ? money(banker.cash) : "—"],
    [veteran, 720, 605, veteran ? minutes(veteran.minutes) : "—"],
    [wins, 170, 773, wins ? counted(wins.wins, ["победа", "победы", "побед"]) : "—"],
    [seed, 720, 773, seed ? minutes(seed.seedMinutes) : "—"],
  ]) {
    await text(row ? nameOf(row) : "Нет данных", x, y, 390, 39, 26);
    await text(result, x, y + 48, 390, 38, 24);
  }
  await text(wins ? counted(wins.matches, ["матч", "матча", "матчей"]) : "—", 170, 854, 390, 19);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">${parts.join("")}</svg>`;
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

