import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WIDTH = 1280;
const HEIGHT = 720;
const WEEKLY_BRAND_IMAGE_URL = "https://i.ibb.co/tTkjsFTm/2.jpg";

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
    return {
      ok: false,
      reason: "dejavu-fonts-ttf не установлен на хосте",
    };
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


async function fetchOptionalImage(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "image/*" },
    });
    if (!response.ok) return null;
    const type = response.headers.get("content-type") || "";
    if (!type.startsWith("image/")) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
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
  return Math.round(num(value)).toLocaleString("ru-RU").replace(/\u00A0/g, " ");
}

function minutes(value) {
  const m = Math.max(0, Math.round(num(value)));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h && rest) return `${h} ч ${rest} мин`;
  if (h) return `${h} ч`;
  return `${rest} мин`;
}

function textSize(value, base, compactAt = 18, min = 22) {
  const len = Array.from(String(value || "")).length;
  if (len <= compactAt) return base;
  return Math.max(min, Math.round(base * compactAt / len));
}

function card({ x, y, w, h, title, name, value, accent = "#d9b46a" }) {
  const fs = textSize(name, 28, 18, 20);
  return `
    <g>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16"
            fill="#111714" fill-opacity="0.94" stroke="#606961" stroke-width="1.5"/>
      <rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${accent}"/>
      <text x="${x + 28}" y="${y + 37}" class="label">${esc(title)}</text>
      <line x1="${x + 28}" y1="${y + 54}" x2="${x + w - 28}" y2="${y + 54}"
            stroke="#4b544d" stroke-width="1"/>
      <text x="${x + 28}" y="${y + 92}" class="name" font-size="${fs}">${esc(name)}</text>
      <text x="${x + 28}" y="${y + h - 27}" class="value">${esc(value)}</text>
    </g>`;
}

function svgFor(stats) {
  const leader = stats.leader || null;
  const banker = stats.banker || null;
  const veteran = stats.veteran || null;
  const wins = stats.wins || null;
  const seed = stats.seed || null;

  const leaderName = leader?.name || leader?.steamId || "—";
  const leaderNameSize = textSize(leaderName, 42, 20, 28);

  const cards = [
    banker && {
      title: "БАНКИР",
      name: banker.name || banker.steamId || "—",
      value: `$ ${money(banker.cash)}`,
      accent: "#d8ae57",
    },
    veteran && {
      title: "ВЕТЕРАН НЕДЕЛИ",
      name: veteran.name || veteran.steamId || "—",
      value: minutes(veteran.minutes),
      accent: "#8797a5",
    },
    wins && {
      title: "ЛИДЕР ПО ПОБЕДАМ",
      name: wins.name || wins.steamId || "—",
      value: `${num(wins.wins)} побед · ${num(wins.matches)} матчей`,
      accent: "#d98a3a",
    },
    seed && {
      title: "SEED-БОЕЦ",
      name: seed.name || seed.steamId || "—",
      value: `${minutes(seed.seedMinutes)} SEED`,
      accent: "#7ea15a",
    },
  ].filter(Boolean);

  const gap = 18;
  const cardsX = 54;
  const cardsWTotal = WIDTH - cardsX * 2;
  const cardW = (cardsWTotal - gap * (cards.length - 1)) / cards.length;
  const cardsSvg = cards.map((item, index) =>
    card({
      x: cardsX + index * (cardW + gap),
      y: 500,
      w: cardW,
      h: 160,
      ...item,
    }),
  ).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b100e"/>
      <stop offset=".55" stop-color="#18201b"/>
      <stop offset="1" stop-color="#090c0b"/>
    </linearGradient>
    <linearGradient id="leader" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#151b17"/>
      <stop offset=".7" stop-color="#0e1310"/>
      <stop offset="1" stop-color="#211b11"/>
    </linearGradient>
    <radialGradient id="glow" cx=".78" cy=".1" r=".75">
      <stop offset="0" stop-color="#b27a32" stop-opacity=".34"/>
      <stop offset=".45" stop-color="#5c4428" stop-opacity=".10"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="42" height="42" patternUnits="userSpaceOnUse">
      <path d="M42 0H0V42" fill="none" stroke="#728077" stroke-opacity=".08" stroke-width="1"/>
    </pattern>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#000" flood-opacity=".45"/>
    </filter>
    <style>
      .title { font-family: "DejaVu Sans", sans-serif; font-weight: 800; fill: #f0e8d8; letter-spacing: 2px; }
      .sub { font-family: "DejaVu Sans", sans-serif; font-weight: 700; fill: #c99c55; letter-spacing: 8px; }
      .label { font-family: "DejaVu Sans", sans-serif; font-size: 21px; font-weight: 800; fill: #e8dec9; letter-spacing: .5px; }
      .name { font-family: "DejaVu Sans", sans-serif; font-weight: 800; fill: #ffffff; }
      .value { font-family: "DejaVu Sans", sans-serif; font-size: 22px; font-weight: 700; fill: #d7c9ae; }
      .muted { font-family: "DejaVu Sans", sans-serif; fill: #9aa39c; }
    </style>
  </defs>

  <rect width="1280" height="720" fill="url(#bg)"/>
  <rect width="1280" height="720" fill="url(#grid)"/>
  <rect width="1280" height="720" fill="url(#glow)"/>

  <path d="M0 118 L320 0 H0 Z" fill="#64726a" opacity=".06"/>
  <path d="M1280 0 L960 0 L1280 154 Z" fill="#d69b48" opacity=".08"/>
  <path d="M0 720 L390 720 L0 570 Z" fill="#a27842" opacity=".05"/>
  <path d="M1280 720 L940 720 L1280 592 Z" fill="#63776a" opacity=".06"/>

  <g opacity=".15">
    <path d="M20 420 C150 380 210 330 320 350 S520 430 640 390 830 290 1020 340 1170 430 1280 382 V720 H0 V470 Z"
          fill="#000"/>
    <path d="M40 420 L120 360 L182 408 L235 320 L310 398 L385 352 L470 424 L540 370 L620 418"
          fill="none" stroke="#839087" stroke-width="2"/>
  </g>

  <g filter="url(#shadow)">
    <rect x="154" y="186" width="972" height="255" rx="24" fill="url(#leader)" stroke="#b98b48" stroke-width="2"/>
    <rect x="154" y="186" width="9" height="255" rx="4" fill="#d6a553"/>
    <text x="204" y="239" class="sub" font-size="22">ЛИДЕР СТАИ</text>
    <text x="204" y="308" class="name" font-size="${leaderNameSize}">${esc(leaderName)}</text>
    <line x1="204" y1="333" x2="1070" y2="333" stroke="#59635b" stroke-width="1"/>
    <text x="204" y="386" class="muted" font-size="19">УБИЙСТВА</text>
    <text x="335" y="386" class="title" font-size="32">${leader ? num(leader.kills) : "—"}</text>
    <text x="550" y="386" class="muted" font-size="19">K/D</text>
    <text x="615" y="386" class="title" font-size="32">${leader ? kdOf(leader).toFixed(2) : "—"}</text>
    <g transform="translate(935 232)" opacity=".92">
      <path d="M0 72 L28 13 L53 45 L90 0 L80 69 L48 92 Z" fill="none" stroke="#d7b365" stroke-width="8" stroke-linejoin="round"/>
      <circle cx="58" cy="48" r="5" fill="#d7b365"/>
    </g>
  </g>

  ${cardsSvg}

  <line x1="54" y1="688" x2="1226" y2="688" stroke="#6e6f67" stroke-opacity=".35"/>
  <text x="54" y="708" class="muted" font-size="15">ZARUBA SERVER · WARDOGS</text>
  <text x="1226" y="708" text-anchor="end" class="muted" font-size="15">СТАТИСТИКА НЕДЕЛИ</text>
</svg>`;
}

export async function renderWeeklyImage(stats) {
  const fonts = prepareCyrillicFonts();
  if (!fonts.ok) {
    return {
      ok: false,
      reason: fonts.reason,
      buffer: null,
    };
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

  try {
    const svg = Buffer.from(svgFor(stats));
    let pipeline = sharp(svg, { density: 144 }).resize(WIDTH, HEIGHT);

    const brandSource = await fetchOptionalImage(WEEKLY_BRAND_IMAGE_URL);
    if (brandSource) {
      try {
        const brand = await sharp(brandSource)
          .resize({
            width: 1180,
            height: 150,
            fit: "cover",
            position: "centre",
            withoutEnlargement: false,
          })
          .png()
          .toBuffer();

        pipeline = pipeline.composite([
          {
            input: brand,
            left: 50,
            top: 18,
          },
        ]);
      } catch (error) {
        console.warn(
          "weekly image logo:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    const buffer = await pipeline
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
