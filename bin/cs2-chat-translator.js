#!/usr/bin/env node
/**
 * CS2 Chat Translator (CLI + Web GUI)
 * ===================================
 *
 * Same tool you had before, now with a local web UI at http://localhost:7420.
 *
 * Modes
 * -----
 *   cs2-chat-translator                 # start watcher + web GUI, open browser
 *   cs2-chat-translator --no-browser    # start watcher + web GUI, do not open browser
 *   cs2-chat-translator --port 1234     # change the web GUI port
 *   cs2-chat-translator --cli           # headless: watcher only, no web GUI (old behavior)
 *   cs2-chat-translator --init-config   # create/refresh config.json
 *   cs2-chat-translator --set-log-path /path/to/console.log
 *   cs2-chat-translator --set-cfg-dir  /path/to/cfg
 *   cs2-chat-translator --set-bind-key l
 *
 * The GUI shows a live chat feed, surfaces auto-translations inline, and lets
 * you edit the config (logPath, cfgDir, bindKey, auto-translate target) without
 * leaving the app. All chat-command handling (tm_<lang>, _tl, code_<lang>) is
 * unchanged.
 *
 * Runtime dependencies (unchanged from the CLI version)
 * -----------------------------------------------------
 *   nodejs 18+, xdotool, google-translate-api-x, chalk, fuzzball
 *   No new dependencies are added for the GUI — it uses Node's built-in http
 *   module and Server-Sent Events.
 */

import fs from "fs";
import http from "http";
import https from "https";
import readline from "readline";
import { exec as execChild, execFile } from "child_process";
import translate from "google-translate-api-x";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import chalk from "chalk";
import * as fuzz from "fuzzball";
import QRCode from "qrcode";

// Shared persistent HTTPS agent to reuse sockets and prevent ephemeral port exhaustion
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 6,
  maxFreeSockets: 2,
  timeout: 5000
});

function httpsGetJson(url, timeoutMs = 2800) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        agent: httpsAgent,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json, text/plain, */*"
        }
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        res.setEncoding("utf8");
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Request timeout"));
    });
    req.on("error", reject);
  });
}

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        if (!iface.address.startsWith("169.254.")) {
          return iface.address;
        }
      }
    }
  }
  return "127.0.0.1";
}

process.on("uncaughtException", (err) => {
  console.error(chalk.red("Uncaught Exception:"), err?.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error(chalk.red("Unhandled Rejection:"), reason?.message || reason);
});

// -----------------------------------------------------------------------------
// File / path utilities and configuration handling
// -----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let LOG_PATH = "";
let CSGO_CFG_DIR = "";
let CHAT_CFG = "";
let BIND_KEY = "o";
let AUTO_TRANSLATE_TARGET = "hu";
let AUTO_TRANSLATE = true;
let TRANSLATION_ENGINE = "smart";
let GEMINI_API_KEY = "";
let GROQ_API_KEY = "";

// Chat-tag prefixes used by the CS2 client. These differ per client language
// (e.g. Russian / Chinese clients use different strings). Users configure them.
let TAG_CT = "T-E";
let TAG_T = "T";
let TAG_ALL = "MINDENKI";
let TAG_REGEX = null;

const BUILTIN_CT_TAGS = [
  "CT", "T-E", "TE", "TERRORELHÁRÍTÓK", "TERRORELHARITOK",
  "COUNTER-TERRORIST", "COUNTER-TERRORISTS", "СПЕЦНАЗ",
  "ANTITERRORISTEN", "AT", "ANTYTERRORYŚCI", "CT-LER", "AT-LER"
];
const BUILTIN_T_TAGS = [
  "T", "TERRORISTÁK", "TERRORISTAK", "TERRORIST", "TERRORISTS",
  "ТЕРРОРИСТЫ", "TERRORISTEN", "TERRORYŚCI", "TERÖRİSTLER"
];
const BUILTIN_ALL_TAGS = [
  "ALL", "MINDENKI", "ÖSSZES", "OSSZES", "ВСЕ", "ОБЩИЙ",
  "ALLE", "TODOS", "TOUS", "WSZYSCY", "HERKES", "GENEL",
  "TUTTI", "TOTS", "SVI", "VŠICHNI", "VŠETCI", "TOȚI",
  "SPEC", "SPECTATOR", "NÉZŐ", "NEZO", "НАБЛЮДАТЕЛЬ"
];

function parseTagList(val) {
  if (!val) return [];
  return String(val).split(/[,|\/]/).map((s) => s.trim()).filter(Boolean);
}

function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rebuildTagRegex() {
  const userCt = parseTagList(TAG_CT);
  const userT = parseTagList(TAG_T);
  const userAll = parseTagList(TAG_ALL);

  const allTags = Array.from(new Set([
    ...BUILTIN_CT_TAGS,
    ...BUILTIN_T_TAGS,
    ...BUILTIN_ALL_TAGS,
    ...userCt,
    ...userT,
    ...userAll
  ])).filter((t) => t && t.trim().length);

  if (!allTags.length) { TAG_REGEX = null; return; }
  const alt = allTags.map(escapeForRegex).join("|");
  TAG_REGEX = new RegExp(`\\[(${alt})\\]\\s+(.+?):\\s*(.+)`, "i");
}

const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, "cs2-chat-translator")
  : process.platform === "win32"
    ? path.join(process.env.APPDATA || os.homedir(), "cs2-chat-translator")
    : path.join(os.homedir(), ".config", "cs2-chat-translator");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

function findCs2Root() {
  if (process.platform !== "win32") {
    return path.join(
      os.homedir(),
      ".local/share/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo"
    );
  }
  const drives = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `${l}:`);
  const subpaths = [
    "SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo",
    "Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo",
    "Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo",
    "Games\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo"
  ];
  for (const d of drives) {
    for (const sub of subpaths) {
      const full = path.join(d, sub);
      if (fs.existsSync(full)) return full;
    }
  }
  return "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo";
}

const guessedRoot = findCs2Root();

const defaultConfig = {
  logPath: path.join(guessedRoot, "console.log"),
  cfgDir: path.join(guessedRoot, "cfg"),
  bindKey: "o",
  autoTranslate: true,
  autoTranslateTarget: "hu",
  tagCT: "T-E",
  tagT: "T",
  tagAll: "MINDENKI",
  playerName: "",
  translationEngine: "smart",
  geminiApiKey: "",
  groqApiKey: ""
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...defaultConfig };
    const txt = fs.readFileSync(CONFIG_PATH, "utf8").trim();
    if (!txt) return { ...defaultConfig };
    const cfg = JSON.parse(txt);
    let engine = cfg.translationEngine || defaultConfig.translationEngine;
    // Automatically upgrade broken/rate-limited pollinations or keyless gemini to "smart"
    if (engine === "pollinations" || (engine === "gemini" && !cfg.geminiApiKey)) {
      engine = "smart";
    }
    return {
      logPath: cfg.logPath || defaultConfig.logPath,
      cfgDir: cfg.cfgDir || defaultConfig.cfgDir,
      bindKey: cfg.bindKey || defaultConfig.bindKey,
      autoTranslate:
        typeof cfg.autoTranslate === "boolean"
          ? cfg.autoTranslate
          : defaultConfig.autoTranslate,
      autoTranslateTarget:
        cfg.autoTranslateTarget || defaultConfig.autoTranslateTarget,
      tagCT: cfg.tagCT || defaultConfig.tagCT,
      tagT: cfg.tagT || defaultConfig.tagT,
      tagAll: cfg.tagAll || defaultConfig.tagAll,
      playerName: cfg.playerName || defaultConfig.playerName,
      translationEngine: engine,
      geminiApiKey: cfg.geminiApiKey || defaultConfig.geminiApiKey,
      groqApiKey: cfg.groqApiKey || defaultConfig.groqApiKey
    };
  } catch (err) {
    console.error(chalk.red(`Failed to load config: ${err.message}`));
    return { ...defaultConfig };
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const merged = {
      logPath: cfg.logPath || defaultConfig.logPath,
      cfgDir: cfg.cfgDir || defaultConfig.cfgDir,
      bindKey: cfg.bindKey || defaultConfig.bindKey,
      autoTranslate:
        typeof cfg.autoTranslate === "boolean"
          ? cfg.autoTranslate
          : defaultConfig.autoTranslate,
      autoTranslateTarget:
        cfg.autoTranslateTarget || defaultConfig.autoTranslateTarget,
      tagCT: cfg.tagCT || defaultConfig.tagCT,
      tagT: cfg.tagT || defaultConfig.tagT,
      tagAll: cfg.tagAll || defaultConfig.tagAll,
      playerName: cfg.playerName || defaultConfig.playerName,
      translationEngine: cfg.translationEngine || defaultConfig.translationEngine,
      geminiApiKey: cfg.geminiApiKey || defaultConfig.geminiApiKey,
      groqApiKey: cfg.groqApiKey || defaultConfig.groqApiKey
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf8");
    return merged;
  } catch (err) {
    console.error(chalk.red(`Failed to write config: ${err.message}`));
    process.exit(1);
  }
}

function initConfigCli() {
  const merged = saveConfig(loadConfig());
  console.log(chalk.green("Config initialized/updated:"));
  console.log(`  ${CONFIG_PATH}`);
  console.log("Effective values:");
  for (const [k, v] of Object.entries(merged)) console.log(`  ${k}: ${v}`);
}

function updateConfigKey(key, value) {
  const cfg = loadConfig();
  cfg[key] = value;
  const merged = saveConfig(cfg);
  console.log(chalk.green(`Config updated (${key}):`));
  console.log(`  ${CONFIG_PATH}`);
  console.log(`  ${key}: ${merged[key]}`);
}

function ensureAutoexecBind() {
  if (!CSGO_CFG_DIR || !fs.existsSync(CSGO_CFG_DIR)) return;
  try {
    // 1. Ensure chat_reader.cfg exists without UTF-8 BOM
    if (CHAT_CFG && !fs.existsSync(CHAT_CFG)) {
      fs.writeFileSync(CHAT_CFG, "// Auto-generated by CS2 Chat Translator\r\n", "utf8");
    } else if (CHAT_CFG && fs.existsSync(CHAT_CFG)) {
      // Strip BOM if present from older versions
      const existing = fs.readFileSync(CHAT_CFG, "utf8");
      if (existing.charCodeAt(0) === 0xFEFF) {
        fs.writeFileSync(CHAT_CFG, existing.slice(1), "utf8");
      }
    }

    // 2. Ensure autoexec.cfg binds BIND_KEY to exec chat_reader.cfg
    const autoexecPath = path.join(CSGO_CFG_DIR, "autoexec.cfg");
    const bindLine = `bind "${BIND_KEY}" "exec chat_reader.cfg"`;
    if (!fs.existsSync(autoexecPath)) {
      fs.writeFileSync(
        autoexecPath,
        `// CS2 Chat Translator Key Bind\r\n${bindLine}\r\n`,
        "utf8"
      );
    } else {
      let content = fs.readFileSync(autoexecPath, "utf8");
      if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
      const bindRegex = new RegExp(`bind\\s+"?${escapeForRegex(BIND_KEY)}"?\\s+"exec\\s+chat_reader`, "i");
      if (!bindRegex.test(content)) {
        const suffix = content.endsWith("\n") ? "" : "\r\n";
        fs.writeFileSync(
          autoexecPath,
          `${content}${suffix}\r\n// CS2 Chat Translator\r\n${bindLine}\r\n`,
          "utf8"
        );
      }
    }
  } catch { /* ignore permission errors */ }
}

function setupFromConfig() {
  const cfg = loadConfig();
  LOG_PATH = cfg.logPath;
  CSGO_CFG_DIR = cfg.cfgDir;
  BIND_KEY = cfg.bindKey || "o";
  AUTO_TRANSLATE = cfg.autoTranslate !== false;
  AUTO_TRANSLATE_TARGET = cfg.autoTranslateTarget || "hu";
  TAG_CT = cfg.tagCT || defaultConfig.tagCT;
  TAG_T = cfg.tagT || defaultConfig.tagT;
  TAG_ALL = cfg.tagAll || defaultConfig.tagAll;
  localPlayerName = cfg.playerName || defaultConfig.playerName;
  TRANSLATION_ENGINE = cfg.translationEngine || "smart";
  GEMINI_API_KEY = cfg.geminiApiKey || "";
  GROQ_API_KEY = cfg.groqApiKey || "";
  rebuildTagRegex();
  CHAT_CFG = path.join(CSGO_CFG_DIR, "chat_reader.cfg");
  ensureAutoexecBind();
}

// -----------------------------------------------------------------------------
// Console styling utilities
// -----------------------------------------------------------------------------

const sym = {
  start: chalk.cyan("🚀"),
  info: chalk.cyan("ℹ️"),
  ok: chalk.green("✅"),
  warn: chalk.yellow("⚠️"),
  err: chalk.red("❌"),
  chat: chalk.magenta("💬"),
  trans: chalk.blueBright("🌍"),
  cfg: chalk.white("📝")
};

function log(prefix, msg) {
  console.log(prefix, msg);
}

function logKV(key, value) {
  console.log(chalk.gray(`   ${key}:`), chalk.white(value));
}

// -----------------------------------------------------------------------------
// Language mapping and auto-translate configuration
// -----------------------------------------------------------------------------

const LANG_MAP = {
  af:"Afrikaans", sq:"Albanian", am:"Amharic", ar:"Arabic", hy:"Armenian",
  az:"Azerbaijani", eu:"Basque", be:"Belarusian", bn:"Bengali", bs:"Bosnian",
  bg:"Bulgarian", ca:"Catalan", ceb:"Cebuano", ny:"Chichewa", zh:"Chinese",
  zh_cn:"Chinese (Simplified)", zh_tw:"Chinese (Traditional)", co:"Corsican",
  hr:"Croatian", cs:"Czech", da:"Danish", nl:"Dutch", en:"English",
  eo:"Esperanto", et:"Estonian", tl:"Filipino", fi:"Finnish", fr:"French",
  fy:"Frisian", gl:"Galician", ka:"Georgian", de:"German", el:"Greek",
  gu:"Gujarati", ht:"Haitian Creole", ha:"Hausa", haw:"Hawaiian", he:"Hebrew",
  hi:"Hindi", hmn:"Hmong", hu:"Hungarian", is:"Icelandic", ig:"Igbo",
  id:"Indonesian", ga:"Irish", it:"Italian", ja:"Japanese", jw:"Javanese",
  kn:"Kannada", kk:"Kazakh", km:"Khmer", rw:"Kinyarwanda", ko:"Korean",
  ku:"Kurdish (Kurmanji)", ky:"Kyrgyz", lo:"Lao", la:"Latin", lv:"Latvian",
  lt:"Lithuanian", lb:"Luxembourgish", mk:"Macedonian", mg:"Malagasy",
  ms:"Malay", ml:"Malayalam", mt:"Maltese", mi:"Maori", mr:"Marathi",
  mn:"Mongolian", my:"Myanmar (Burmese)", ne:"Nepali", no:"Norwegian",
  or:"Odia (Oriya)", ps:"Pashto", fa:"Persian", pl:"Polish", pt:"Portuguese",
  pa:"Punjabi", ro:"Romanian", ru:"Russian", sm:"Samoan", gd:"Scots Gaelic",
  sr:"Serbian", st:"Sesotho", sn:"Shona", sd:"Sindhi", si:"Sinhala",
  sk:"Slovak", sl:"Slovenian", so:"Somali", es:"Spanish", su:"Sundanese",
  sw:"Swahili", sv:"Swedish", tg:"Tajik", ta:"Tamil", tt:"Tatar", te:"Telugu",
  th:"Thai", tr:"Turkish", tk:"Turkmen", uk:"Ukrainian", ur:"Urdu",
  ug:"Uyghur", uz:"Uzbek", vi:"Vietnamese", cy:"Welsh", xh:"Xhosa",
  yi:"Yiddish", yo:"Yoruba", zu:"Zulu"
};

const PREFER_RU_FOR_CYRILLIC = true;
const CYRILLIC_REGEX = /[\u0400-\u04FF]/;

// -----------------------------------------------------------------------------
// SSE broadcast plumbing for the web GUI
// -----------------------------------------------------------------------------

const sseClients = new Set();
const recentEvents = [];
const MAX_RECENT = 300;

function broadcast(type, payload) {
  const evt = { type, payload, at: Date.now() };
  recentEvents.push(evt);
  if (recentEvents.length > MAX_RECENT) recentEvents.shift();
  const data = `event: ${type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { /* client gone, will be cleaned up */ }
  }
}

// -----------------------------------------------------------------------------
// Low-level helpers: CFG writing and key press simulation
// -----------------------------------------------------------------------------

function escapeForCfg(text) {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

let localPlayerName = "";
const recentBotMessages = new Set();

function writeChatCfg({ message, team = false }) {
  const safe = escapeForCfg(message);
  recentBotMessages.add(message.trim().toLowerCase());
  if (recentBotMessages.size > 80) {
    const first = recentBotMessages.values().next().value;
    recentBotMessages.delete(first);
  }
  const cmd = team ? `say_team "${safe}"` : `say "${safe}"`;
  // Write clean UTF-8 WITHOUT BOM so Source 2 parser never chokes on the first line
  fs.writeFileSync(
    CHAT_CFG,
    `${cmd}\r\n`,
    "utf8"
  );
  log(sym.cfg, `Wrote to cfg: ${team ? "say_team" : "say"} → ${message}`);
  broadcast("cfg", { team, message });
}

function pressBindKey() {
  if (process.platform === "win32") {
    const keys = Array.from(new Set([BIND_KEY, "o", "l"])).filter(Boolean).join(" ");
    const candidates = [
      path.join(__dirname, "KeySender.exe"),
      path.join(__dirname, "..", "bin", "KeySender.exe"),
      path.join(__dirname, "..", "KeySender.exe"),
      path.join(__dirname, "..", "dist", "CS2-Chat-Translator", "KeySender.exe"),
      path.join(__dirname, "..", "dist", "CS2-Chat-Translator", "bin", "KeySender.exe"),
      path.join(__dirname, "CS2ChatTranslator.exe"),
      path.join(__dirname, "..", "dist", "CS2-Chat-Translator", "CS2ChatTranslator.exe"),
      path.join(__dirname, "..", "desktop-app", "bin", "Release", "net10.0-windows", "CS2ChatTranslator.exe"),
      path.join(__dirname, "..", "desktop-app", "bin", "Release", "net8.0-windows", "CS2ChatTranslator.exe")
    ];

    let targetExe = null;
    let isApp = false;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        if (c.toLowerCase().endsWith("cs2chattranslator.exe")) {
          const dllPath = path.join(path.dirname(c), "CS2ChatTranslator.dll");
          if (!fs.existsSync(dllPath)) continue;
          isApp = true;
        }
        targetExe = c;
        break;
      }
    }

    if (targetExe) {
      const cmd = isApp ? `"${targetExe}" --press-key ${keys}` : `"${targetExe}" ${keys}`;
      execChild(cmd, { cwd: path.dirname(targetExe) }, (err, stdout) => {
        if (err) {
          log(sym.warn, chalk.yellow(`Key send error: ${err.message}`));
          broadcast("error", { message: `Key send error: ${err.message}` });
        } else if (stdout && stdout.trim()) {
          log(sym.cfg, chalk.gray(`Key sender: ${stdout.trim().replace(/\r?\n/g, ' ')}`));
        }
      });
    } else {
      log(sym.warn, chalk.yellow("No valid key sender executable found."));
    }
  } else {
    execChild(`xdotool key ${BIND_KEY}`, (err) => {
      if (err) {
        log(sym.warn, chalk.yellow(`xdotool error: ${err.message}`));
        broadcast("error", { message: `xdotool error: ${err.message}` });
      }
    });
  }
}

function langName(iso) {
  const key = (iso || "").toLowerCase();
  return LANG_MAP[key] || key.toUpperCase() || "UNKNOWN";
}

// -----------------------------------------------------------------------------
// Translation logic (100% Free CS2 Smart Multi-Engine + LRU Cache + Connection Reuse)
// -----------------------------------------------------------------------------

const translationCache = new Map();
const MAX_CACHE_SIZE = 500;

function getCachedTranslation(text, toLang) {
  const key = `${toLang.toLowerCase()}:${text.trim().toLowerCase()}`;
  if (translationCache.has(key)) {
    const val = translationCache.get(key);
    // Refresh LRU order
    translationCache.delete(key);
    translationCache.set(key, val);
    return val;
  }
  return null;
}

function setCachedTranslation(text, toLang, result) {
  const key = `${toLang.toLowerCase()}:${text.trim().toLowerCase()}`;
  translationCache.set(key, result);
  if (translationCache.size > MAX_CACHE_SIZE) {
    const oldest = translationCache.keys().next().value;
    translationCache.delete(oldest);
  }
}

// Pre-normalizes Russian & CIS CS2 gamer slang so neural translators output natural sentences
const RU_CS2_SLANG_RULES = [
  [/(?<![\p{L}\p{N}])(дропни|дроп)(?![\p{L}\p{N}])/giu, "скинь"],
  [/(?<![\p{L}\p{N}])дропните(?![\p{L}\p{N}])/giu, "скиньте"],
  [/(?<![\p{L}\p{N}])(авик|авапу|авапа|авп)(?![\p{L}\p{N}])/giu, "AWP"],
  [/(?<![\p{L}\p{N}])(калаш|калаша|калашом)(?![\p{L}\p{N}])/giu, "AK-47"],
  [/(?<![\p{L}\p{N}])(эмку|эмка|эмкой)(?![\p{L}\p{N}])/giu, "M4"],
  [/(?<![\p{L}\p{N}])(дигл|дигла)(?![\p{L}\p{N}])/giu, "Deagle"],
  [/(?<![\p{L}\p{N}])(муха|муху|скаут)(?![\p{L}\p{N}])/giu, "Scout"],
  [/(?<![\p{L}\p{N}])(петух|петуха)(?![\p{L}\p{N}])/giu, "P90"],
  [/(?<![\p{L}\p{N}])(плент|плэнт|пленту)(?![\p{L}\p{N}])/giu, "плент (место бомбы)"],
  [/(?<![\p{L}\p{N}])пачка(?![\p{L}\p{N}])/giu, "бомба (C4)"],
  [/(?<![\p{L}\p{N}])пачку(?![\p{L}\p{N}])/giu, "бомбу (C4)"],
  [/(?<![\p{L}\p{N}])(деф|дефуз|дефать|дефай)(?![\p{L}\p{N}])/giu, "разминировать"],
  [/(?<![\p{L}\p{N}])(зига|зигу|зиге)(?![\p{L}\p{N}])/giu, "шорт (зига)"],
  [/(?<![\p{L}\p{N}])(ковры|коврах|апсы|апсах)(?![\p{L}\p{N}])/giu, "апартаменты (Palace)"],
  [/(?<![\p{L}\p{N}])(децл|ваншот|лоу\s*хп|лоу)(?![\p{L}\p{N}])/giu, "мало ХП (на один выстрел)"],
  [/(?<![\p{L}\p{N}])(смок|смока|смоки)(?![\p{L}\p{N}])/giu, "дым (смок)"],
  [/(?<![\p{L}\p{N}])(флеш|флешка|флешку|флэш)(?![\p{L}\p{N}])/giu, "флешка"],
  [/(?<![\p{L}\p{N}])(молик|молотов)(?![\p{L}\p{N}])/giu, "коктейль Молотова"],
  [/(?<![\p{L}\p{N}])(хае|хаешка|хаешку)(?![\p{L}\p{N}])/giu, "граната HE"],
  [/(?<![\p{L}\p{N}])(сейв|сейви|сейвим)(?![\p{L}\p{N}])/giu, "сохрани оружие (сейв)"],
  [/(?<![\p{L}\p{N}])(эко)(?![\p{L}\p{N}])/giu, "эко-раунд"],
  [/(?<![\p{L}\p{N}])(форс|форсим)(?![\p{L}\p{N}])/giu, "форс-бай (закуп)"],
  [/(?<![\p{L}\p{N}])(инфа|инфу)(?![\p{L}\p{N}])/giu, "информация"],
  [/(?<![\p{L}\p{N}])(плиз|плз|пж)(?![\p{L}\p{N}])/giu, "пожалуйста"],
  [/(?<![\p{L}\p{N}])(спс|сяб)(?![\p{L}\p{N}])/giu, "спасибо"],
  [/(?<![\p{L}\p{N}])(сори|сорри|сорян)(?![\p{L}\p{N}])/giu, "извини"],
  [/(?<![\p{L}\p{N}])(здарова|прив|ку)(?![\p{L}\p{N}])/giu, "привет"],
  [/(?<![\p{L}\p{N}])(гг)(?![\p{L}\p{N}])/giu, "GG"],
  [/(?<![\p{L}\p{N}])(нт)(?![\p{L}\p{N}])/giu, "хорошая попытка (NT)"],
  [/(?<![\p{L}\p{N}])(гх)(?![\p{L}\p{N}])/giu, "хорошая половина (GH)"]
];

function preprocessCs2Slang(text) {
  let out = String(text || "");
  if (CYRILLIC_REGEX.test(out)) {
    for (const [pattern, replacement] of RU_CS2_SLANG_RULES) {
      out = out.replace(pattern, replacement);
    }
  }
  return out;
}

// Provider 1: Direct Google GTX endpoint (100% free, no key, ~60ms via persistent HTTPS agent)
async function translateViaGtx(text, toLang = "hu", sl = "auto") {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(toLang)}&dt=t&q=${encodeURIComponent(text)}`;
  const data = await httpsGetJson(url, 2500);
  if (Array.isArray(data) && Array.isArray(data[0])) {
    const translated = data[0].map((seg) => (Array.isArray(seg) ? seg[0] : "")).join("").trim();
    const detected = typeof data[2] === "string" ? data[2].toLowerCase() : (sl !== "auto" ? sl : "unknown");
    if (translated) {
      return { text: translated, from: { language: { iso: detected } } };
    }
  }
  throw new Error("Invalid GTX response");
}

// Provider 2: Google Clients5 Dictionary API (100% free, no key, ultra-reliable secondary endpoint)
async function translateViaClients5(text, toLang = "hu", sl = "auto") {
  const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(toLang)}&q=${encodeURIComponent(text)}`;
  const data = await httpsGetJson(url, 2500);
  if (Array.isArray(data)) {
    const first = data[0];
    if (Array.isArray(first) && typeof first[0] === "string") {
      return {
        text: first[0].trim(),
        from: { language: { iso: (first[1] || (sl !== "auto" ? sl : "unknown")).toLowerCase() } }
      };
    }
    if (typeof first === "string") {
      return {
        text: first.trim(),
        from: { language: { iso: sl !== "auto" ? sl : "unknown" } }
      };
    }
  }
  throw new Error("Invalid Clients5 response");
}

// Provider 3: MyMemory Translated.net Free API (100% free fallback)
async function translateViaMyMemory(text, toLang = "hu", sl = "en") {
  const sourceLang = sl === "auto" ? (CYRILLIC_REGEX.test(text) ? "ru" : "en") : sl;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(sourceLang)}|${encodeURIComponent(toLang)}`;
  const data = await httpsGetJson(url, 3000);
  const translated = data?.responseData?.translatedText?.trim();
  if (translated && !translated.includes("MYMEMORY WARNING")) {
    return {
      text: translated,
      from: { language: { iso: sourceLang } }
    };
  }
  throw new Error("MyMemory failed");
}

// Multi-provider 100% free universal translation pipeline
async function freeUniversalTranslate(rawText, toLang = "hu") {
  const isCyrillic = CYRILLIC_REGEX.test(rawText);
  const preparedText = preprocessCs2Slang(rawText);
  const preferredSl = (PREFER_RU_FOR_CYRILLIC && isCyrillic && toLang.toLowerCase() !== "ru") ? "ru" : "auto";

  // 1. Primary: Direct GTX over persistent keep-alive socket
  try {
    const res = await translateViaGtx(preparedText, toLang, preferredSl);
    if (preferredSl === "ru") res.__forcedFrom = "ru";
    return res;
  } catch { /* fallback to Clients5 */ }

  // 2. Secondary: Google Clients5 Dictionary API over persistent keep-alive socket
  try {
    const res = await translateViaClients5(preparedText, toLang, preferredSl);
    if (preferredSl === "ru") res.__forcedFrom = "ru";
    return res;
  } catch { /* fallback to google-translate-api-x */ }

  // 3. Tertiary: google-translate-api-x
  try {
    const opts = preferredSl === "ru" ? { from: "ru", to: toLang } : { to: toLang };
    const res = await translate(preparedText, opts);
    if (preferredSl === "ru") res.__forcedFrom = "ru";
    return res;
  } catch { /* fallback to MyMemory */ }

  // 4. Quaternary: MyMemory Free API
  return await translateViaMyMemory(preparedText, toLang, preferredSl);
}

async function translateWithAi(text, toLang = "en") {
  const targetLang = langName(toLang);
  const isCyrillic = CYRILLIC_REGEX.test(text);
  const sysPrompt = `You are a real-time CS2 (Counter-Strike 2) in-game chat translator. Translate the text directly to ${targetLang} (${toLang}).
Rules:
- Understand CS2 gamer slang, callouts, weapon names, tactics (e.g., eco, rush, drop, plant, defuse, ct, t, mid, long, short, banan, smoke, flash).
- Translate Russian, Turkish, Polish, German, etc. into natural Hungarian gamer language.
- Keep CS2 weapon names (AK, AWP, M4, Deagle) and site letters (A, B) intact.
- Output ONLY the raw translated text, without quotes, markdown, or explanations.`;

  // 1. Google Gemini Flash AI (only if user configured an API key)
  if (TRANSLATION_ENGINE === "gemini" && GEMINI_API_KEY) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2500);
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${sysPrompt}\n\nTranslate this message:\n${text}` }] }],
          generationConfig: { maxOutputTokens: 120, temperature: 0.1 }
        })
      });
      clearTimeout(t);
      if (resp.ok) {
        const data = await resp.json();
        let cand = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (cand) {
          if (cand.startsWith('"') && cand.endsWith('"')) cand = cand.slice(1, -1).trim();
          return { text: cand, from: { language: { iso: isCyrillic ? "ru" : "unknown" } } };
        }
      }
    } catch { /* fallback */ }
  }

  // 2. Groq Llama 3 AI (only if user configured an API key)
  if (TRANSLATION_ENGINE === "groq" && GROQ_API_KEY) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2500);
      const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: sysPrompt },
            { role: "user", content: text }
          ],
          max_tokens: 120,
          temperature: 0.1
        })
      });
      clearTimeout(t);
      if (resp.ok) {
        const data = await resp.json();
        let cand = data.choices?.[0]?.message?.content?.trim();
        if (cand) {
          if (cand.startsWith('"') && cand.endsWith('"')) cand = cand.slice(1, -1).trim();
          return { text: cand, from: { language: { iso: isCyrillic ? "ru" : "unknown" } } };
        }
      }
    } catch { /* fallback */ }
  }

  // 3. Default & Fallback: 100% Free CS2 Smart Universal Multi-Engine
  return await freeUniversalTranslate(text, toLang);
}

async function smartTranslate(text, toLang = "en") {
  const clean = String(text || "").trim();
  if (!clean) return { text: "", from: { language: { iso: toLang } } };

  const cached = getCachedTranslation(clean, toLang);
  if (cached) return cached;

  try {
    let res;
    if (TRANSLATION_ENGINE === "smart" || TRANSLATION_ENGINE === "google" || TRANSLATION_ENGINE === "pollinations") {
      res = await freeUniversalTranslate(clean, toLang);
    } else {
      res = await translateWithAi(clean, toLang);
    }
    if (res && res.text) {
      setCachedTranslation(clean, toLang, res);
    }
    return res;
  } catch (err) {
    log(sym.warn, chalk.yellow(`Translation failed: ${err.message}`));
    broadcast("error", { message: `Translation failed: ${err.message}` });
    return { text: clean, from: { language: { iso: "unknown" } }, __failed: true };
  }
}

function originalLangReadable(res) {
  const iso = (res.__forcedFrom || res.from?.language?.iso || "unknown").toLowerCase();
  return langName(iso);
}

// -----------------------------------------------------------------------------
// code_<language name> command
// -----------------------------------------------------------------------------

function normalizeQueryLoose(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildLangCandidates() {
  return Object.entries(LANG_MAP).map(([code, name]) => {
    const bare = name.replace(/\s*\([^)]*\)\s*/g, "").trim();
    const aliases = new Set([
      name.toLowerCase(),
      bare.toLowerCase(),
      code.toLowerCase()
    ]);
    if (code === "zh_cn") { aliases.add("simplified chinese"); aliases.add("chinese simplified"); }
    if (code === "zh_tw") { aliases.add("traditional chinese"); aliases.add("chinese traditional"); }
    if (code === "ga")    { aliases.add("irish gaelic"); }
    if (code === "gd")    { aliases.add("scottish gaelic"); aliases.add("scots gaelic"); }
    if (code === "jw")    { aliases.add("javanese"); }
    if (code === "my")    { aliases.add("burmese"); }
    if (code === "tl")    { aliases.add("tagalog"); }
    if (code === "pt")    { aliases.add("brazilian portuguese"); aliases.add("brasilianisch"); }
    if (code === "he")    { aliases.add("ivrit"); }
    return { code, name, aliases: Array.from(aliases) };
  });
}

function bestLangMatch(query) {
  const q = normalizeQueryLoose(query);
  if (!q) return null;
  const candidates = buildLangCandidates();
  for (const c of candidates) {
    if (c.aliases.some((a) => a === q)) return { code: c.code, name: c.name, score: 100 };
  }
  let best = null;
  for (const c of candidates) {
    const score = Math.max(...c.aliases.map((a) => fuzz.ratio(q, a)));
    if (!best || score > best.score) best = { code: c.code, name: c.name, score };
  }
  return best && best.score >= 55 ? best : null;
}

function handleCodeLang({ isTeam, message }) {
  const m = message.match(/^code[_\s]+(.+)$/i);
  if (!m) return false;
  const query = m[1].trim();
  if (!query) return true;

  const match = bestLangMatch(query);
  if (match) {
    const reply = `For ${match.name} use tm_${match.code}`;
    writeChatCfg({ message: reply, team: isTeam });
    setTimeout(pressBindKey, 280);
    log(sym.info, chalk.cyan(`code → ${reply} (score ${match.score})`));
    broadcast("command", { kind: "code", query, reply, score: match.score });
  } else {
    const reply =
      `No close language match for "${query}". Try tm_en, tm_de, tm_fr, tm_es, tm_ru, tm_pt...`;
    writeChatCfg({ message: reply, team: isTeam });
    setTimeout(pressBindKey, 280);
    log(sym.warn, chalk.yellow(reply));
    broadcast("command", { kind: "code", query, reply, score: 0 });
  }
  return true;
}

// -----------------------------------------------------------------------------
// Commands: tm_ and _tl
// -----------------------------------------------------------------------------

let lastForeignMsg = null;

async function handleTm({ isTeam, sender, message }) {
  if (!/^tm_[a-z_]{2,5}\b/i.test(message)) return false;
  const [cmd, ...rest] = message.split(" ");
  const lang = cmd.slice(3).toLowerCase();
  const text = rest.join(" ").trim();
  if (!text) return true;

  const res = await smartTranslate(text, lang);
  const translated = res.text;
  const originalLang = originalLangReadable(res);

  const output = translated;
  writeChatCfg({ message: output, team: isTeam });
  setTimeout(pressBindKey, 280);

  log(sym.trans, chalk.blueBright(`tm_${lang} → sent to chat`));
  logKV("from", originalLang);
  logKV("text", translated);
  broadcast("command", {
    kind: "tm", target: lang, from: originalLang,
    sender, original: text, translated
  });
  return true;
}

async function handleTl({ isTeam, message }) {
  if (!/^_tl\b/i.test(message)) return false;

  if (!lastForeignMsg) {
    const msg = "No recent message to translate.";
    writeChatCfg({ message: msg, team: isTeam });
    setTimeout(pressBindKey, 280);
    log(sym.warn, chalk.yellow(msg));
    broadcast("command", { kind: "tl", status: "no-last", reply: msg });
    return true;
  }

  const parts = message.split(" ");
  const target = parts[1]?.toLowerCase() || "en";

  const res = await smartTranslate(lastForeignMsg.message, target);
  const translated = res.text;
  const originalLang = originalLangReadable(res);
  const output = translated;

  writeChatCfg({ message: output, team: isTeam });
  setTimeout(pressBindKey, 280);

  log(sym.trans, chalk.blueBright(`_tl → ${target}`));
  logKV("from", originalLang);
  logKV("player", lastForeignMsg.player);
  logKV("text", translated);
  broadcast("command", {
    kind: "tl", target, from: originalLang,
    sender: lastForeignMsg.player, original: lastForeignMsg.message, translated
  });
  return true;
}

// -----------------------------------------------------------------------------
// Auto-translate to console (and now also to the GUI feed)
// -----------------------------------------------------------------------------

async function autoTranslateToConsole({ team, sender, message }) {
  if (!AUTO_TRANSLATE) return;
  if (!message) return;
  if (/^(_tl\b|tm_[a-z_]{2,5}\b|code[_\s])/i.test(message)) return;
  if (/^[.\s?!0-9+\-*\/=()[\]{}<>:;'"@#$%^&~`|\\]+$/.test(message)) return;

  // Do not re-translate messages generated by this translator bot
  if (recentBotMessages.has(message.trim().toLowerCase())) return;

  const res = await smartTranslate(message, AUTO_TRANSLATE_TARGET);
  if (!res || res.__failed || !res.text) return;

  const fromIso = (res.__forcedFrom || res.from?.language?.iso || "unknown").toLowerCase();
  const targetIso = AUTO_TRANSLATE_TARGET.toLowerCase();

  // Skip if already in target language and text didn't change
  if (fromIso === targetIso) return;
  if (
    res.text.trim().toLowerCase() === message.trim().toLowerCase() &&
    !CYRILLIC_REGEX.test(message)
  ) {
    return;
  }

  const readableLang = langName(fromIso);
  console.log(
    sym.trans,
    chalk.blueBright(
      `[${team}] ${sender} (${readableLang} → ${AUTO_TRANSLATE_TARGET.toUpperCase()}): `
    ) + chalk.gray(res.text)
  );
  broadcast("auto", {
    team, sender,
    fromIso, fromName: readableLang,
    target: AUTO_TRANSLATE_TARGET,
    translated: res.text,
    original: message
  });
}

// -----------------------------------------------------------------------------
// Log line parsing
// -----------------------------------------------------------------------------

async function handleLine(line) {
  if (!TAG_REGEX) return;
  const match = line.match(TAG_REGEX);
  if (!match) return;

  const [, matchedTag, player, messageRaw] = match;

  // Normalize the matched (possibly localized) tag to canonical CT / T / ALL
  // so downstream styling, tm_/_tl logic, and the UI stay language-agnostic.
  const upperTag = (matchedTag || "").toUpperCase();
  const userCt = parseTagList(TAG_CT).map(s => s.toUpperCase());
  const userT = parseTagList(TAG_T).map(s => s.toUpperCase());
  let team = "ALL";
  if (BUILTIN_CT_TAGS.some(t => t.toUpperCase() === upperTag) || userCt.includes(upperTag)) {
    team = "CT";
  } else if (BUILTIN_T_TAGS.some(t => t.toUpperCase() === upperTag) || userT.includes(upperTag)) {
    team = "T";
  }

  const message = (messageRaw || "").trim();
  const cleanSender = (player || "")
    .replace(/[\u200E\u200F\u202A-\u202E]/g, "")
    .replace(/\s*\[(HALOTT|DEAD|МЕРТВ|МЁРТВ|TOT|ÖLÜ)\]\s*/gi, "")
    .replace(/\s*\((HALOTT|DEAD|МЕРТВ|МЁРТВ|TOT|ÖLÜ)\)\s*/gi, "")
    .replace(/\s*\*(HALOTT|DEAD|МЕРТВ|МЁРТВ|TOT|ÖLÜ)\*\s*/gi, "")
    .replace(/[\u0040\uFE6B\uFF20].*$/, "")
    .trim();
  const sender = cleanSender || (player || "").trim();
  const isTeam = team === "CT" || team === "T";

  if (/^(_tl\b|tm_[a-z_]{2,5}\b|code[_\s])/i.test(message)) {
    localPlayerName = sender;
  }

  const isBotMessage = recentBotMessages.has(message.trim().toLowerCase());

  log(
    sym.chat,
    chalk.magentaBright(`[${team}] `) +
      chalk.bold(sender) +
      chalk.white(": ") +
      chalk.white(message)
  );

  if (!isBotMessage) {
    broadcast("chat", { team, sender, message, rawTag: matchedTag });
  }

  if (
    !isBotMessage &&
    !/^tm_[a-z_]{2,5}\b|^_tl\b|^code[_\s]/i.test(message) &&
    !/^[.\s]+$/.test(message)
  ) {
    lastForeignMsg = { player: sender, message, team };
  }

  if (await handleTl({ isTeam, message })) return;
  if (handleCodeLang({ isTeam, message })) return;
  if (await handleTm({ isTeam, sender, message })) return;

  if (isBotMessage) return;

  await autoTranslateToConsole({ team, sender, message });
}

// -----------------------------------------------------------------------------
// File watcher (extracted so the GUI can restart it after a config change)
// -----------------------------------------------------------------------------

let currentlyWatching = null;

function stopWatching() {
  if (currentlyWatching) {
    fs.unwatchFile(currentlyWatching);
    currentlyWatching = null;
  }
}

function startWatching() {
  stopWatching();
  if (!fs.existsSync(LOG_PATH)) {
    const dir = path.dirname(LOG_PATH);
    if (fs.existsSync(dir)) {
      try {
        fs.writeFileSync(LOG_PATH, "", "utf8");
        log(sym.info, chalk.gray(`Created empty ${LOG_PATH}`));
      } catch (e) {
        // ignore
      }
    }
  }
  if (!fs.existsSync(LOG_PATH)) {
    console.error(chalk.red(`❌ console.log not found: ${LOG_PATH}`));
    broadcast("status", {
      watching: false,
      error: `console.log not found: ${LOG_PATH}`
    });
    return false;
  }
  if (!fs.existsSync(CSGO_CFG_DIR)) {
    console.error(chalk.red(`❌ cfg directory not found: ${CSGO_CFG_DIR}`));
    broadcast("status", {
      watching: false,
      error: `cfg directory not found: ${CSGO_CFG_DIR}`
    });
    return false;
  }

  currentlyWatching = LOG_PATH;
  fs.watchFile(LOG_PATH, { interval: 500 }, (curr, prev) => {
    if (curr.size <= prev.size) {
      if (curr.size < prev.size) {
        const stream = fs.createReadStream(LOG_PATH, {
          start: 0, end: curr.size, encoding: "utf8"
        });
        stream.on("error", (err) => console.error(chalk.gray(`Stream read error: ${err.message}`)));
        const rl = readline.createInterface({ input: stream });
        rl.on("error", (err) => console.error(chalk.gray(`Readline error: ${err.message}`)));
        rl.on("line", (line) => {
          Promise.resolve(handleLine(line)).catch((err) => {
            console.error(chalk.red("Line handling error:"), err);
            broadcast("error", { message: `Line handling: ${err.message}` });
          });
        });
      }
      return;
    }
    const stream = fs.createReadStream(LOG_PATH, {
      start: prev.size, end: curr.size, encoding: "utf8"
    });
    stream.on("error", (err) => console.error(chalk.gray(`Stream read error: ${err.message}`)));
    const rl = readline.createInterface({ input: stream });
    rl.on("error", (err) => console.error(chalk.gray(`Readline error: ${err.message}`)));
    rl.on("line", (line) => {
      Promise.resolve(handleLine(line)).catch((err) => {
        console.error(chalk.red("Line handling error:"), err);
        broadcast("error", { message: `Line handling: ${err.message}` });
      });
    });
  });
  broadcast("status", { watching: true, logPath: LOG_PATH });
  return true;
}

let isCs2Running = false;

function checkCs2Process() {
  if (process.platform !== "win32") return;
  execFile("tasklist", ["/FI", "IMAGENAME eq cs2.exe", "/NH"], { windowsHide: true }, (err, stdout) => {
    if (err) return;
    const running = (stdout || "").toLowerCase().includes("cs2.exe");
    if (running !== isCs2Running) {
      isCs2Running = running;
      broadcast("game_status", { running: isCs2Running });
    }
  });
}
// Ha a desktop app indítja (--parent-pid), a C# natívan figyeli a cs2.exe-t, nem kell 2.5mp-enként tasklist.exe-t indítani!
if (!process.argv.includes("--parent-pid")) {
  setInterval(checkCs2Process, 8000);
  checkCs2Process();
} else {
  const pidIdx = process.argv.indexOf("--parent-pid");
  const parentPid = Number(process.argv[pidIdx + 1]);
  if (parentPid > 0 && !Number.isNaN(parentPid)) {
    setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        process.exit(0);
      }
    }, 3000);
  }
}

function statusSnapshot() {
  return {
    watching: !!currentlyWatching,
    gameRunning: isCs2Running,
    logPath: LOG_PATH,
    cfgDir: CSGO_CFG_DIR,
    bindKey: BIND_KEY,
    autoTranslate: AUTO_TRANSLATE,
    autoTranslateTarget: AUTO_TRANSLATE_TARGET,
    tagCT: TAG_CT,
    tagT: TAG_T,
    tagAll: TAG_ALL,
    playerName: localPlayerName,
    logExists: LOG_PATH ? fs.existsSync(LOG_PATH) : false,
    cfgDirExists: CSGO_CFG_DIR ? fs.existsSync(CSGO_CFG_DIR) : false,
    configPath: CONFIG_PATH,
    translationEngine: TRANSLATION_ENGINE
  };
}

// -----------------------------------------------------------------------------
// HTTP server (web GUI)
// -----------------------------------------------------------------------------

const INDEX_HTML = String.raw`<!doctype html>
<html lang="en" data-theme="dark" data-size="md">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, interactive-widget=resizes-content" />
<meta name="theme-color" content="#0b0b0c" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="CS2 Translator" />
<link rel="manifest" href="/manifest.json" />
<title>CS2 Chat Translator</title>
<style>
  :root {
    /* Theme-tokens (dark defaults; light overrides below) */
    --bg-alpha: 0.95;
    --bg: rgba(11, 11, 12, var(--bg-alpha));
    --surface: rgba(20, 20, 22, var(--bg-alpha));
    --surface-2: rgba(28, 28, 31, var(--bg-alpha));
    --border: #26262a;
    --border-strong: #3a3a40;
    --text: #e8e8ea;
    --muted: #7d7d84;
    --muted-2: #55555b;
    --good: #65b881;
    --bad: #d46464;
    --info: #7ab0d9;
    --warm: #d99464;

    /* User-customizable accent + font */
    --accent: #d9a84b;
    --accent-dim: #77602a;
    --accent-ink: #1a1205; /* text color on an accent button */
    --font: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --base-size: 13px;
  }
  html[data-theme="light"] {
    --bg: #fafaf7;
    --surface: #ffffff;
    --surface-2: #f1f1ec;
    --border: #e3e3dc;
    --border-strong: #c4c4ba;
    --text: #1a1a1c;
    --muted: #6a6a6e;
    --muted-2: #a5a5a9;
    --good: #2f8a4e;
    --bad: #c24040;
    --info: #3d82b8;
    --warm: #b4682f;
    --accent-ink: #1a1205;
  }
  html[data-size="sm"] { --base-size: 12px; }
  html[data-size="md"] { --base-size: 13px; }
  html[data-size="lg"] { --base-size: 14.5px; }

  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: var(--bg); color: var(--text);
    font-family: var(--font); font-size: var(--base-size); line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  body {
    display: grid;
    grid-template-rows: auto 1fr;
    grid-template-columns: 1fr;
    min-height: 100vh;
  }

  /* Header */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    gap: 8px;
    transition: opacity 160ms ease, max-height 160ms ease;
    user-select: none;
    cursor: default;
    flex-shrink: 0;
    overflow: hidden;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .brand .mark {
    background: var(--accent);
    color: #111;
    font-weight: 700;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 4px;
    letter-spacing: 0.04em;
    line-height: 1.2;
  }
  .brand .name {
    color: var(--text);
    font-weight: 600;
    font-size: 12px;
    letter-spacing: -0.01em;
    white-space: nowrap;
  }
  .header-right {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    padding: 3px 6px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid var(--border);
    cursor: default;
    flex-shrink: 0;
  }
  .status .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--muted-2);
    flex-shrink: 0;
  }
  .status.on .dot {
    background: var(--good);
    animation: pulse 2s ease-in-out infinite;
  }
  .status.bad .dot { background: var(--bad); }
  .status.warn .dot {
    background: #f59e0b;
    box-shadow: 0 0 0 0 rgba(245,158,11,0.35);
    animation: pulse-warn 2s ease-in-out infinite;
  }
  @keyframes pulse-warn {
    0%, 100% { box-shadow: 0 0 0 0 rgba(245,158,11,0.35); }
    50%      { box-shadow: 0 0 0 6px rgba(245,158,11,0); }
  }
  .status .label {
    color: var(--muted);
    font-weight: 600;
    font-size: 10px;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .status.on .label { color: var(--good); }
  .status.bad .label { color: var(--bad); }
  .status.warn .label { color: #f59e0b; }

  /* Tool Button (Pin, etc) */
  .tool-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    font-size: 11px;
    border-radius: 4px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    cursor: pointer;
    transition: all 120ms;
    flex-shrink: 0;
  }
  .tool-btn:hover {
    border-color: var(--border-strong);
    color: var(--text);
  }
  .tool-btn.active {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    border-color: var(--accent);
    color: var(--accent);
  }

  /* Window Controls */
  .win-controls {
    display: inline-flex;
    align-items: center;
    gap: 1px;
    margin-left: 2px;
    padding-left: 4px;
    border-left: 1px solid var(--border);
    flex-shrink: 0;
  }
  .win-controls.hidden {
    display: none !important;
  }
  .win-btn {
    width: 28px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 0;
    border-radius: 4px;
    color: var(--muted);
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    line-height: 1;
    transition: all 120ms;
  }
  .win-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
  }
  .win-btn.win-close:hover {
    background: #ef4444;
    color: #fff;
  }

  /* Responsive Rules for Narrow / HUD windows */
  @media (max-width: 800px) {
    .brand .name { display: none; }
  }
  @media (max-width: 680px) {
    .status .label { display: none; }
    .status { padding: 4px 6px; }
  }
  @media (max-width: 580px) {
    .phone-btn span { display: none; }
    .phone-btn { padding: 0 5px; }
  }

  .game-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 10px 16px 0;
    padding: 10px 14px;
    background: rgba(245, 158, 11, 0.12);
    border: 1px solid rgba(245, 158, 11, 0.4);
    border-radius: 6px;
    color: #fbbf24;
    font-size: 12px;
    animation: fade-in 180ms ease-out;
    flex-shrink: 0;
  }
  .game-banner.hidden { display: none !important; }
  .game-banner-icon { font-size: 18px; line-height: 1; flex-shrink: 0; }
  .game-banner-text { flex: 1; min-width: 0; }
  .game-banner-text strong { color: #f3f4f6; display: block; font-size: 12px; margin-bottom: 2px; }
  .game-banner-text span { color: #9ca3af; font-size: 11px; }
  .game-banner-text code { color: #f59e0b; background: rgba(0,0,0,0.3); padding: 1px 4px; border-radius: 3px; font-family: var(--font); }

  .icon-btn {
    width: 30px; height: 30px;
    display: inline-flex; align-items: center; justify-content: center;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--muted);
    cursor: pointer;
    padding: 0;
    transition: border-color 120ms, color 120ms;
  }
  .icon-btn:hover { border-color: var(--border-strong); color: var(--text); }
  .icon-btn svg { width: 14px; height: 14px; display: block; }

  /* Main layout — flex so sidebar can collapse smoothly */
  main {
    display: flex;
    min-height: 0;
    overflow: hidden;
    align-items: stretch;
  }
  .feed-container {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: calc(100vh - 45px);
  }
  .feed {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    padding: 16px 24px;
    scroll-behavior: smooth;
  }
  .send-bar {
    flex: 0 0 auto;
    padding: 10px 16px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    transition: opacity 160ms ease, max-height 160ms ease;
  }
  .send-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .send-select {
    padding: 8px 10px;
    background: rgba(0, 0, 0, 0.35);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-family: var(--font);
    font-size: 12px;
    outline: none;
    cursor: pointer;
    flex-shrink: 0;
    transition: border-color 120ms;
  }
  .send-select:focus {
    border-color: var(--accent);
  }
  .send-input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.35);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-family: var(--font);
    font-size: 13px;
    outline: none;
    transition: border-color 120ms;
  }
  .send-input:focus {
    border-color: var(--accent);
  }
  .send-btn {
    flex-shrink: 0;
    padding: 8px 18px;
    font-weight: 600;
  }
  .send-feedback {
    min-height: 16px;
    font-size: 11px;
    margin-top: 6px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .send-feedback.ok { color: var(--good); }
  .send-feedback.err { color: var(--bad); }
  aside {
    flex: 0 0 360px;
    width: 360px;
    overflow-y: auto;
    padding: 20px 20px 32px;
    border-left: 1px solid var(--border);
    background: var(--surface);
    transition: flex-basis 220ms ease, width 220ms ease, padding 220ms ease, border-left-color 220ms ease;
  }
  main.aside-hidden aside {
    display: none !important;
  }
  @media (max-width: 900px) {
    main { flex-direction: column; }
    aside { flex: 0 0 auto; width: 100%; max-height: 55vh; border-left: 0; border-top: 1px solid var(--border); }
  }

  @media (max-width: 600px) {
    .phone-btn { display: none; }
    .brand .tag { display: none; }
    .feed { padding: 12px 14px; }
    .send-bar { padding: 8px 10px; }
    .send-row { flex-wrap: wrap; gap: 6px; }
    .send-select { font-size: 11px; padding: 6px 8px; flex: 1 1 45%; }
    .send-input { font-size: 13px; padding: 8px 10px; flex: 1 1 100%; order: 3; }
    .send-btn { flex: 1 1 100%; order: 4; padding: 9px 0; }
  }

  /* Phone button */
  .phone-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    font-size: 11px;
    font-weight: 500;
    border-radius: 4px;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    color: var(--accent);
    cursor: pointer;
    transition: all 120ms;
  }
  .phone-btn:hover {
    background: color-mix(in srgb, var(--accent) 25%, transparent);
    border-color: var(--accent);
  }

  /* HUD button */
  .hud-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    font-size: 11px;
    font-weight: 500;
    border-radius: 4px;
    background: color-mix(in srgb, var(--info) 18%, transparent);
    border: 1px solid color-mix(in srgb, var(--info) 38%, transparent);
    color: var(--info);
    cursor: pointer;
    transition: all 120ms;
  }
  .hud-btn:hover {
    background: color-mix(in srgb, var(--info) 30%, transparent);
    border-color: var(--info);
  }
  body.hud-mode .hud-btn,
  .hud-btn.active {
    background: var(--info) !important;
    color: #ffffff !important;
  }

  /* HUD Mode: Simultaneously hide top bar and bottom send-bar for ultra-clean gameplay overlay */
  body.hud-mode header,
  body.hud-mode .send-bar,
  body.hud-mode .game-banner {
    display: none !important;
  }
  body.hud-mode .feed-container {
    height: 100vh !important;
  }
  body.hud-mode .feed {
    padding: 8px 14px;
  }

  /* HUD Mode: Mouse hover temporarily reveals both top and bottom bars */
  body.hud-mode:hover header {
    display: flex !important;
    animation: fade-in 140ms ease-out;
  }
  body.hud-mode:hover .send-bar {
    display: flex !important;
    animation: fade-in 140ms ease-out;
  }
  body.hud-mode:hover .feed-container {
    height: calc(100vh - 45px - 53px) !important;
  }

  /* Modal */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    animation: fade-in 150ms ease-out;
  }
  .modal-overlay.hidden { display: none; }
  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .modal-card {
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    width: 380px;
    max-width: calc(100vw - 32px);
    padding: 20px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .modal-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .modal-close {
    background: transparent;
    border: 0;
    color: var(--muted);
    font-size: 24px;
    cursor: pointer;
    line-height: 1;
    padding: 0 4px;
  }
  .modal-close:hover { color: var(--text); }
  .qr-code-box {
    width: 220px;
    height: 220px;
    margin: 0 auto 16px;
    background: #101218;
    border: 1px solid var(--border);
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 12px;
  }
  .qr-code-box svg {
    width: 100%;
    height: 100%;
  }
  .qr-url-box {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }
  .qr-url-box input {
    flex: 1;
    padding: 7px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--accent);
    font-family: var(--font);
    font-size: 11px;
    outline: none;
  }
  .qr-hint {
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--muted);
    text-align: center;
  }
  .qr-hint em {
    color: var(--muted-2);
    font-style: normal;
  }

  /* Scrollbars */
  .feed::-webkit-scrollbar, aside::-webkit-scrollbar { width: 10px; }
  .feed::-webkit-scrollbar-track, aside::-webkit-scrollbar-track { background: transparent; }
  .feed::-webkit-scrollbar-thumb {
    background: var(--border); border-radius: 10px; border: 2px solid var(--bg);
  }
  aside::-webkit-scrollbar-thumb {
    background: var(--border-strong); border-radius: 10px; border: 2px solid var(--surface);
  }

  /* Feed entries */
  .feed-empty {
    color: var(--muted); text-align: center;
    padding: 64px 16px; font-style: italic;
  }
  .feed-empty .hint {
    display: block; margin-top: 8px; font-style: normal;
    color: var(--muted-2); font-size: 11px;
  }
  .entry {
    display: grid;
    grid-template-columns: 64px 1fr;
    gap: 12px;
    padding: 8px 0;
    border-top: 1px solid transparent;
    animation: slide-in 160ms ease-out;
  }
  .entry + .entry { border-top: 1px dashed var(--border); }
  @keyframes slide-in {
    from { opacity: 0; transform: translateY(2px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .entry .meta {
    color: var(--muted-2); font-size: 11px; padding-top: 2px;
    font-variant-numeric: tabular-nums;
  }
  .entry .body { min-width: 0; }
  .entry .body .line { word-wrap: break-word; word-break: break-word; }

  .tag {
    display: inline-block; padding: 1px 6px;
    font-size: 10px; letter-spacing: 0.08em;
    text-transform: uppercase;
    border-radius: 2px; margin-right: 6px;
    vertical-align: 1px;
    border: 1px solid var(--border-strong);
    color: var(--muted);
  }
  .tag.ct  { color: var(--info);  border-color: color-mix(in srgb, var(--info) 40%, transparent); }
  .tag.t   { color: var(--warm);  border-color: color-mix(in srgb, var(--warm) 40%, transparent); }
  .tag.all { color: var(--muted); border-color: var(--border-strong); }

  .sender { color: var(--text); font-weight: 500; }
  .msg    { color: color-mix(in srgb, var(--text) 75%, transparent); }

  .translation {
    margin-top: 0; padding-left: 0;
    border-left: none;
    color: var(--text);
  }
  .translation .lang {
    display: inline-block; padding: 1px 7px;
    font-size: 11px; font-weight: 600;
    border-radius: 4px; margin-right: 8px;
    border: 1px solid var(--border-strong);
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent);
  }
  .translation .sender { color: var(--text); font-weight: 600; }
  .translation .msg { color: var(--text); }
  .translation .translated { color: var(--text); }

  .entry.system .body .line { color: var(--muted); font-style: italic; }
  .entry.error  .body .line { color: var(--bad); }
  .entry.command .body .line { color: var(--text); }
  .entry.command .kind {
    display: inline-block; color: var(--accent); font-weight: 500;
    margin-right: 6px;
  }

  /* Sidebar sections */
  .section { margin-bottom: 28px; }
  .section h2 {
    margin: 0 0 12px 0;
    font-size: 11px; font-weight: 500;
    text-transform: uppercase; letter-spacing: 0.14em;
    color: var(--muted);
  }
  .subhead {
    margin: 18px 0 10px;
    font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--muted-2);
  }

  .field { margin-bottom: 12px; }
  .field label {
    display: block; margin-bottom: 4px;
    font-size: 11px; color: var(--muted);
  }
  .field input[type="text"], .field select {
    width: 100%; padding: 8px 10px;
    background: var(--bg); color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-family: var(--font); font-size: 12px;
    outline: none; transition: border-color 120ms;
    appearance: none;
  }
  .field select {
    background-image:
      linear-gradient(45deg, transparent 50%, var(--muted) 50%),
      linear-gradient(135deg, var(--muted) 50%, transparent 50%);
    background-position: calc(100% - 14px) 50%, calc(100% - 10px) 50%;
    background-size: 4px 4px, 4px 4px;
    background-repeat: no-repeat;
    padding-right: 26px;
  }
  .field input[type="text"]:focus, .field select:focus {
    border-color: var(--accent-dim);
  }
  .field .row-3 {
    display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;
  }
  .field .row-2 {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
  }
  .field .hint {
    color: var(--muted-2); font-size: 10px; margin-top: 4px; line-height: 1.5;
  }

  .toggle {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
  }
  .toggle .label { font-size: 12px; color: var(--text); }
  .switch {
    position: relative; width: 32px; height: 18px;
    background: var(--border-strong); border-radius: 10px;
    cursor: pointer; transition: background 120ms;
  }
  .switch::after {
    content: ""; position: absolute; top: 2px; left: 2px;
    width: 14px; height: 14px; border-radius: 50%;
    background: var(--muted); transition: all 120ms;
  }
  .switch.on { background: var(--accent-dim); }
  .switch.on::after { left: 16px; background: var(--accent); }

  /* Segmented (theme/size) */
  .seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 3px;
    overflow: hidden;
    width: 100%;
  }
  .seg button {
    flex: 1; padding: 7px 0;
    background: var(--bg); color: var(--muted);
    border: 0; border-left: 1px solid var(--border);
    border-radius: 0;
    font-family: var(--font); font-size: 11px;
    cursor: pointer; transition: background 120ms, color 120ms;
  }
  .seg button:first-child { border-left: 0; }
  .seg button:hover { color: var(--text); }
  .seg button.active {
    background: var(--surface-2); color: var(--accent);
  }

  /* Swatches (accent presets) */
  .swatches { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .swatch {
    width: 22px; height: 22px; border-radius: 50%;
    cursor: pointer; border: 2px solid transparent;
    transition: transform 120ms, border-color 120ms;
    position: relative;
  }
  .swatch:hover { transform: scale(1.08); }
  .swatch.active { border-color: var(--text); }
  .swatch-custom {
    display: inline-flex; align-items: center; gap: 6px;
    margin-left: auto; font-size: 11px; color: var(--muted);
  }
  input[type="color"] {
    width: 26px; height: 22px; padding: 0; cursor: pointer;
    background: transparent; border: 1px solid var(--border);
    border-radius: 3px;
  }
  input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; }
  input[type="color"]::-webkit-color-swatch { border: 0; border-radius: 2px; }

  .actions { display: flex; gap: 8px; margin-top: 14px; }
  button.btn {
    padding: 8px 14px;
    background: transparent; color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    font-family: var(--font); font-size: 12px;
    cursor: pointer; transition: all 120ms;
  }
  button.btn:hover:not(:disabled) {
    border-color: var(--accent-dim); color: var(--accent);
  }
  button.btn.primary {
    background: var(--accent); color: var(--accent-ink);
    border-color: var(--accent); font-weight: 500;
  }
  button.btn.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 85%, white);
  }
  button.btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .toast {
    margin-top: 10px; min-height: 16px;
    font-size: 11px; color: var(--muted);
  }
  .toast.ok { color: var(--good); }
  .toast.err { color: var(--bad); }

  /* Command reference */
  .cmds .cmd { padding: 10px 0; border-top: 1px solid var(--border); }
  .cmds .cmd:first-child { border-top: 0; }
  .cmds .cmd code { color: var(--accent); font-weight: 500; }
  .cmds .cmd p {
    margin: 4px 0 0 0;
    color: var(--muted); font-size: 11px; line-height: 1.5;
  }
  .cmds .cmd .ex {
    color: var(--muted-2); font-size: 11px; margin-top: 2px;
  }
  .cmds .cmd .ex span { color: var(--muted); }

  .path-hint {
    color: var(--muted-2); font-size: 10px; margin-top: 6px;
    word-break: break-all;
  }

  .warn-banner {
    margin-bottom: 18px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--bad) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--bad) 35%, transparent);
    border-radius: 3px;
    color: var(--bad); font-size: 11px;
  }
  .warn-banner.hidden { display: none; }
</style>
</head>
<body>

<header>
  <div class="brand">
    <span class="mark">CS2</span>
    <span class="name">Translator</span>
  </div>
  <div class="header-right">
    <button class="hud-btn" id="hudBtn" title="HUD nézet: felső fejléc és alsó küldősáv együttes elrejtése / megjelenítése (Gyorsgomb: H)">
      <span>📐 HUD</span>
    </button>
    <button class="tool-btn" id="pinBtn" title="Mindig felül (Always on Top)">📌</button>
    <button class="phone-btn" id="phoneBtn" title="Telefonos csatlakozás (QR kód)">
      <span>📱 Telefon</span>
    </button>
    <div class="status off" id="status" title="Szerver és játék állapot">
      <span class="dot"></span>
      <span class="label" id="statusLabel">INDÍTÁS...</span>
    </div>
    <button class="icon-btn" id="asideToggle" aria-label="Toggle sidebar" aria-expanded="true" title="Beállítások (Ctrl+B)">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/>
        <line x1="10" y1="2.5" x2="10" y2="13.5"/>
      </svg>
    </button>
    <div class="win-controls" id="winControls">
      <button class="win-btn" id="winMinBtn" title="Kis méret">—</button>
      <button class="win-btn" id="winMaxBtn" title="Teljes méret / Visszaállítás">🗖</button>
      <button class="win-btn win-close" id="winCloseBtn" title="Bezárás">✕</button>
    </div>
  </div>
</header>

<div class="modal-overlay hidden" id="qrModal">
  <div class="modal-card">
    <div class="modal-header">
      <div class="modal-title">📱 Telefonos csatlakozás</div>
      <button class="modal-close" id="qrCloseBtn" aria-label="Bezárás">&times;</button>
    </div>
    <div class="modal-body">
      <div class="qr-code-box" id="qrCodeContainer">
        <span>QR kód betöltése…</span>
      </div>
      <div class="qr-url-box">
        <input type="text" id="qrUrlInput" readonly spellcheck="false" />
        <button class="btn" id="qrCopyBtn">Másolás</button>
      </div>
      <p class="qr-hint">
        Irányítsd a telefonod kameráját a QR kódra a megnyitáshoz!<br/>
        <em>(A telefonnak ugyanarra a Wi-Fi hálózatra kell csatlakoznia, mint a PC-nek)</em>
      </p>
    </div>
  </div>
</div>

<main id="main" class="aside-hidden">
  <div class="feed-container">
    <div class="game-banner" id="gameBanner">
      <span class="game-banner-icon">⚠️</span>
      <div class="game-banner-text">
        <strong>A Counter-Strike 2 jelenleg nem fut!</strong>
        <span>Indítsd el a játékot a chat fordításához (Steam indítási opció: <code>-condebug</code>).</span>
      </div>
    </div>
    <section class="feed" id="feed">
      <div class="feed-empty" id="feedEmpty">
        🎮 A Counter-Strike 2 nem fut
        <span class="hint">Indítsd el a CS2-t a lefordított üzenetek automatikus megjelenítéséhez!</span>
      </div>
    </section>

    <form class="send-bar" id="sendForm">
      <div class="send-row">
        <select id="sendLang" class="send-select" title="Célnyelv">
          <option value="ru">🇷🇺 Orosz (ru)</option>
          <option value="en">🇬🇧 Angol (en)</option>
          <option value="de">🇩🇪 Német (de)</option>
          <option value="fr">🇫🇷 Francia (fr)</option>
          <option value="es">🇪🇸 Spanyol (es)</option>
          <option value="tr">🇹🇷 Török (tr)</option>
          <option value="pl">🇵🇱 Lengyel (pl)</option>
          <option value="uk">🇺🇦 Ukrán (uk)</option>
          <option value="ro">🇷🇴 Román (ro)</option>
          <option value="it">🇮🇹 Olasz (it)</option>
          <option value="pt">🇵🇹 Portugál (pt)</option>
          <option value="cs">🇨🇿 Cseh (cs)</option>
          <option value="sk">🇸🇰 Szlovák (sk)</option>
          <option value="sr">🇷🇸 Szerb (sr)</option>
          <option value="zh_cn">🇨🇳 Kínai (zh)</option>
        </select>
        <select id="sendTeam" class="send-select" title="Célcsatorna">
          <option value="all">🌐 Mindenki (say)</option>
          <option value="team">🛡️ Csapat (say_team)</option>
        </select>
        <input type="text" id="sendInput" class="send-input" placeholder="Ide írd a szöveget... (Enter = Fordítás és küldés in-game)" autocomplete="off" />
        <button type="submit" id="sendBtn" class="btn primary send-btn">Küldés</button>
      </div>
      <div class="send-feedback" id="sendFeedback"></div>
    </form>
  </div>

  <aside id="aside">
    <div class="warn-banner hidden" id="warnBanner"></div>

    <div class="section">
      <h2>Configuration</h2>
      <div class="field">
        <label for="playerName">Saját játékosnév (kiszűréshez)</label>
        <input id="playerName" type="text" spellcheck="false" />
      </div>
      <div class="field">
        <label for="logPath">Console log</label>
        <input id="logPath" type="text" spellcheck="false" />
      </div>
      <div class="field">
        <label for="cfgDir">CFG directory</label>
        <input id="cfgDir" type="text" spellcheck="false" />
      </div>
      <div class="field">
        <div class="row-2">
          <div>
            <label for="bindKey">Bind key</label>
            <input id="bindKey" type="text" spellcheck="false" maxlength="16" />
          </div>
          <div>
            <label for="autoTarget">Target</label>
            <input id="autoTarget" type="text" spellcheck="false" maxlength="6" />
          </div>
        </div>
      </div>

      <div class="subhead">Chat tag prefixes</div>
      <div class="field">
        <div class="row-3">
          <div>
            <label for="tagCT">CT team</label>
            <input id="tagCT" type="text" spellcheck="false" maxlength="16" />
          </div>
          <div>
            <label for="tagT">T team</label>
            <input id="tagT" type="text" spellcheck="false" maxlength="16" />
          </div>
          <div>
            <label for="tagAll">All-chat</label>
            <input id="tagAll" type="text" spellcheck="false" maxlength="16" />
          </div>
        </div>
        <div class="hint">CS2 writes a bracketed tag before each chat line (e.g. <code>[CT]</code>). Override if your client is in another language.</div>
      </div>

      <div class="field" style="margin-top:14px;">
        <label>Auto-translate non-commands</label>
        <div class="toggle">
          <span class="label">Show auto-translations in feed</span>
          <div class="switch" id="autoSwitch" role="button" tabindex="0" aria-label="Toggle auto-translate"></div>
        </div>
      </div>

      <div class="subhead" style="margin-top:14px;">Fordító motor (Translation Engine)</div>
      <div class="field">
        <label for="engineSelect">AI / Fordító motor</label>
        <select id="engineSelect" style="width:100%;margin-top:4px;padding:6px 10px;background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:4px;font-family:inherit;font-size:12px;">
          <option value="smart">🚀 CS2 Okos Fordító (100% Ingyenes, Kulcs Nélküli - Ajánlott)</option>
          <option value="gemini">✨ Google Gemini AI (Ingyenes API kulccsal)</option>
          <option value="groq">⚡ Groq Llama 3 AI (Ingyenes API kulccsal)</option>
          <option value="google">🔍 Google Translate (Klasszikus)</option>
        </select>
      </div>

      <div class="field" id="geminiKeyField" style="margin-top:8px;">
        <label for="geminiApiKey">Gemini API kulcs (Ingyenes: <a href="https://aistudio.google.com/app/apikey" target="_blank" style="color:var(--accent);">AI Studio</a>)</label>
        <input id="geminiApiKey" type="password" placeholder="AIzaSy... (vagy hagyd üresen a kulcs nélkülihez)" spellcheck="false" />
      </div>

      <div class="field" id="groqKeyField" style="margin-top:8px;display:none;">
        <label for="groqApiKey">Groq API kulcs (Ingyenes: <a href="https://console.groq.com/keys" target="_blank" style="color:var(--accent);">console.groq.com</a>)</label>
        <input id="groqApiKey" type="password" placeholder="gsk_..." spellcheck="false" />
      </div>

      <div class="actions">
        <button class="btn primary" id="saveBtn">Save</button>
        <button class="btn" id="restartBtn">Restart watcher</button>
      </div>
      <div class="toast" id="toast"></div>
      <div class="path-hint" id="cfgPathHint"></div>
    </div>

    <div class="section">
      <h2>Appearance</h2>

      <div class="field">
        <label>Theme</label>
        <div class="seg" id="segTheme">
          <button data-val="dark" class="active">Dark</button>
          <button data-val="light">Light</button>
        </div>
      </div>

      <div class="field">
        <label>Accent</label>
        <div class="swatches" id="swatches">
          <div class="swatch" data-val="#d9a84b" style="background:#d9a84b" title="Amber"></div>
          <div class="swatch" data-val="#65b881" style="background:#65b881" title="Terminal"></div>
          <div class="swatch" data-val="#7dd3fc" style="background:#7dd3fc" title="Ice"></div>
          <div class="swatch" data-val="#e06666" style="background:#e06666" title="Crimson"></div>
          <div class="swatch" data-val="#c9b8ff" style="background:#c9b8ff" title="Lilac"></div>
          <div class="swatch" data-val="#e8e8ea" style="background:#e8e8ea" title="Mono"></div>
          <div class="swatch-custom">
            <span>custom</span>
            <input type="color" id="accentPicker" value="#d9a84b" aria-label="Custom accent color" />
          </div>
        </div>
      </div>

      <div class="field">
        <label for="fontSel">Font</label>
        <select id="fontSel">
          <option value='"JetBrains Mono", ui-monospace, monospace'>JetBrains Mono</option>
          <option value='"IBM Plex Mono", ui-monospace, monospace'>IBM Plex Mono</option>
          <option value='"Fira Code", ui-monospace, monospace'>Fira Code</option>
          <option value='"Space Mono", ui-monospace, monospace'>Space Mono</option>
          <option value='"IBM Plex Sans", ui-sans-serif, system-ui'>IBM Plex Sans</option>
          <option value='"Inter", ui-sans-serif, system-ui'>Inter</option>
        </select>
      </div>

      <div class="field">
        <label>Density</label>
        <div class="seg" id="segSize">
          <button data-val="sm">Small</button>
          <button data-val="md" class="active">Medium</button>
          <button data-val="lg">Large</button>
        </div>
      </div>

      <div class="actions">
        <button class="btn" id="resetAppearance">Reset appearance</button>
      </div>
    </div>

    <div class="section cmds">
      <h2>In-game commands</h2>
      <div class="cmd">
        <code>tm_&lt;lang&gt; TEXT</code>
        <p>Translate TEXT and send to chat.</p>
        <div class="ex"><span>e.g.</span> tm_de hello friend</div>
      </div>
      <div class="cmd">
        <code>_tl [lang]</code>
        <p>Translate the previous non-command message (default: en).</p>
        <div class="ex"><span>e.g.</span> _tl fr</div>
      </div>
      <div class="cmd">
        <code>code_&lt;language&gt;</code>
        <p>Fuzzy lookup: replies with the right <code>tm_&lt;code&gt;</code>.</p>
        <div class="ex"><span>e.g.</span> code_french → For French use tm_fr</div>
      </div>
    </div>
  </aside>
</main>

<script>
  const feedEl = document.getElementById('feed');
  const feedEmpty = document.getElementById('feedEmpty');
  const statusEl = document.getElementById('status');
  const statusLabel = document.getElementById('statusLabel');
  const warnBanner = document.getElementById('warnBanner');
  const toast = document.getElementById('toast');
  const cfgPathHint = document.getElementById('cfgPathHint');
  const mainEl = document.getElementById('main');
  const asideToggle = document.getElementById('asideToggle');

  const playerNameInput = document.getElementById('playerName');
  const logPathInput = document.getElementById('logPath');
  const cfgDirInput  = document.getElementById('cfgDir');
  const bindKeyInput = document.getElementById('bindKey');
  const autoTargetInput = document.getElementById('autoTarget');
  const tagCTInput = document.getElementById('tagCT');
  const tagTInput = document.getElementById('tagT');
  const tagAllInput = document.getElementById('tagAll');
  const autoSwitch = document.getElementById('autoSwitch');
  const saveBtn = document.getElementById('saveBtn');
  const restartBtn = document.getElementById('restartBtn');
  const engineSelect = document.getElementById('engineSelect');
  const geminiKeyField = document.getElementById('geminiKeyField');
  const geminiApiKeyInput = document.getElementById('geminiApiKey');
  const groqKeyField = document.getElementById('groqKeyField');
  const groqApiKeyInput = document.getElementById('groqApiKey');

  const segTheme = document.getElementById('segTheme');
  const segSize  = document.getElementById('segSize');
  const swatches = document.getElementById('swatches');
  const accentPicker = document.getElementById('accentPicker');
  const fontSel = document.getElementById('fontSel');
  const resetAppearanceBtn = document.getElementById('resetAppearance');

  const LS_SIDEBAR    = 'cs2ct.sidebar';
  const LS_APPEARANCE = 'cs2ct.appearance';

  let autoTranslateOn = true;
  let hasEntry = false;

  /* --------------------------------------------------------
   * Helpers
   * ------------------------------------------------------ */
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toTimeString().slice(0,8);
  }
  function atBottom() {
    return feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 60;
  }
  function darken(hex, factor) {
    const h = (hex || '').replace('#','');
    if (!/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(h)) return '#77602a';
    const n = h.length === 3 ? h.split('').map(c=>c+c).join('') : h;
    const r = Math.max(0, Math.min(255, Math.round(parseInt(n.slice(0,2),16) * factor)));
    const g = Math.max(0, Math.min(255, Math.round(parseInt(n.slice(2,4),16) * factor)));
    const b = Math.max(0, Math.min(255, Math.round(parseInt(n.slice(4,6),16) * factor)));
    return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
  }
  function relLuminance(hex) {
    const h = (hex || '#888888').replace('#','');
    const n = h.length === 3 ? h.split('').map(c=>c+c).join('') : h;
    const [r,g,b] = [0,2,4].map(i => parseInt(n.slice(i,i+2),16) / 255).map(v =>
      v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    );
    return 0.2126*r + 0.7152*g + 0.0722*b;
  }

  /* --------------------------------------------------------
   * Feed renderers
   * ------------------------------------------------------ */
  function append(html) {
    if (!hasEntry) { feedEmpty.remove(); hasEntry = true; }
    const wasBottom = atBottom();
    feedEl.insertAdjacentHTML('beforeend', html);
    if (wasBottom) feedEl.scrollTop = feedEl.scrollHeight;
    while (feedEl.children.length > 400) feedEl.removeChild(feedEl.firstElementChild);
  }
  function renderChat(evt) {
    // Rejtve per kérés
  }
  function renderAuto(evt) {
    const p = evt.payload;
    append(
      '<div class="entry auto">' +
        '<div class="meta">' + fmtTime(evt.at) + '</div>' +
        '<div class="body"><div class="line translation">' +
          '<span class="lang">' + escapeHtml(p.fromName) + ' → ' + escapeHtml(p.target.toUpperCase()) + '</span>' +
          '<span class="sender">' + escapeHtml(p.sender) + '</span>' +
          '<span class="msg">: <span class="translated">' + escapeHtml(p.translated) + '</span></span>' +
        '</div></div>' +
      '</div>'
    );
  }
  function renderCommand(evt) {
    // Rejtve per kérés
  }
  function renderSystem(text) {
    // Rejtve per kérés
  }
  function renderError(text) {
    append(
      '<div class="entry error">' +
        '<div class="meta">' + fmtTime(Date.now()) + '</div>' +
        '<div class="body"><div class="line">' + escapeHtml(text) + '</div></div>' +
      '</div>'
    );
  }

  let isGameRunning = false;
  function updateGameStatus(running) {
    isGameRunning = !!running;
    const gameBanner = document.getElementById('gameBanner');
    const feedEmpty = document.getElementById('feedEmpty');

    statusEl.classList.remove('on', 'bad', 'off', 'warn');

    if (isGameRunning) {
      statusEl.classList.add('on');
      statusLabel.textContent = 'CS2: FUT';
      statusEl.title = 'CS2 észlelve (figyelés aktív)';
      if (gameBanner) gameBanner.classList.add('hidden');
      if (feedEmpty && feedEl.querySelectorAll('.entry').length === 0) {
        feedEmpty.innerHTML = 'Várakozás lefordított üzenetekre…<span class="hint">Csak az idegen nyelvű üzenetek magyar fordítása jelenik meg itt</span>';
      }
    } else {
      statusEl.classList.add('warn');
      statusLabel.textContent = 'CS2: NEM FUT';
      statusEl.title = 'CS2 nem fut — indítsd el a játékot!';
      if (gameBanner) gameBanner.classList.remove('hidden');
      if (feedEmpty && feedEl.querySelectorAll('.entry').length === 0) {
        feedEmpty.innerHTML = '🎮 A Counter-Strike 2 jelenleg nem fut!<span class="hint">Indítsd el a CS2-t a lefordított üzenetek automatikus megjelenítéséhez!</span>';
      }
    }
  }
  window.setGameStatus = updateGameStatus;

  let isHudMode = false;
  function setHudMode(enable) {
    isHudMode = !!enable;
    document.body.classList.toggle('hud-mode', isHudMode);
    const hudBtn = document.getElementById('hudBtn');
    if (hudBtn) {
      hudBtn.classList.toggle('active', isHudMode);
      hudBtn.title = isHudMode 
        ? "HUD mód KIKAPCSOLÁSA (Fejléc és alsó sáv megjelenítése)" 
        : "HUD mód BEKAPCSOLÁSA (Fejléc és alsó sáv együttes elrejtése - Gyorsgomb: H)";
    }
  }
  window.setHudMode = setHudMode;

  const hudBtn = document.getElementById('hudBtn');
  if (hudBtn) {
    hudBtn.addEventListener('click', (e) => {
      e.preventDefault();
      setHudMode(!isHudMode);
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ type: 'toggleHud', isHud: isHudMode });
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if ((e.key === 'h' || e.key === 'H') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      setHudMode(!isHudMode);
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ type: 'toggleHud', isHud: isHudMode });
      }
    }
  });

  // Window dragging & double click maximize
  const headerEl = document.querySelector('header');
  if (headerEl) {
    headerEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('button, input, select, textarea, a, .icon-btn, .win-btn, .hud-btn, .phone-btn, .tool-btn')) {
        return;
      }
      if (e.button === 0 && window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ type: 'dragMove' });
      }
    });

    headerEl.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, input, select, textarea, a, .icon-btn, .win-btn, .hud-btn, .phone-btn, .tool-btn')) {
        return;
      }
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ type: 'toggleMaximize' });
      }
    });
  }

  // Pin button (Always on top)
  let isPinned = false;
  const pinBtn = document.getElementById('pinBtn');
  if (pinBtn) {
    pinBtn.addEventListener('click', (e) => {
      e.preventDefault();
      isPinned = !isPinned;
      pinBtn.classList.toggle('active', isPinned);
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ type: 'togglePin', isPinned: isPinned });
      }
    });
  }

  // Window Min / Max / Close buttons
  const winMinBtn = document.getElementById('winMinBtn');
  const winMaxBtn = document.getElementById('winMaxBtn');
  const winCloseBtn = document.getElementById('winCloseBtn');
  const winControls = document.getElementById('winControls');

  // Hide winControls and desktop tools if not running inside WebView2 (e.g. mobile browser)
  if (!window.chrome || !window.chrome.webview) {
    if (winControls) winControls.classList.add('hidden');
    if (pinBtn) pinBtn.style.display = 'none';
  }

  if (winMinBtn) {
    winMinBtn.addEventListener('click', () => {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ type: 'minimize' });
      }
    });
  }
  if (winMaxBtn) {
    winMaxBtn.addEventListener('click', () => {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ type: 'toggleMaximize' });
      }
    });
  }
  if (winCloseBtn) {
    winCloseBtn.addEventListener('click', () => {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ type: 'close' });
      }
    });
  }

  function updateStatus(s) {
    if (!s) return;
    if (typeof s.gameRunning === 'boolean') {
      if (!window.chrome || !window.chrome.webview) { updateGameStatus(s.gameRunning); }
      return;
    }
    statusEl.classList.remove('on', 'bad', 'off', 'warn');
    if (s.watching) {
      statusEl.classList.add('on');
      statusLabel.textContent = 'FIGYELÉS';
      statusEl.title = 'watching console.log';
      warnBanner.classList.add('hidden');
    } else {
      statusEl.classList.add('bad');
      statusLabel.textContent = s.error ? 'HIBA' : 'OFFLINE';
      statusEl.title = s.error || 'offline';
      if (s.error) {
        warnBanner.classList.remove('hidden');
        warnBanner.textContent = s.error;
      }
    }
  }

  function handleEvent(evt) {
    switch (evt.type) {
      case 'auto':        renderAuto(evt); break;
      case 'status':      updateStatus(evt.payload); break;
      case 'game_status': updateGameStatus(evt.payload.running); break;
      case 'error':       renderError(evt.payload.message); break;
      case 'chat':        break; // Hidden: only translations shown
      case 'command':     break; // Hidden
      case 'cfg':         break;
      default: break;
    }
  }

  function setToast(text, cls) {
    toast.textContent = text || '';
    toast.className = 'toast' + (cls ? ' ' + cls : '');
    if (text) setTimeout(() => {
      if (toast.textContent === text) { toast.textContent=''; toast.className='toast'; }
    }, 2800);
  }

  function setSwitch(on) {
    autoTranslateOn = !!on;
    autoSwitch.classList.toggle('on', autoTranslateOn);
    autoSwitch.setAttribute('aria-checked', String(autoTranslateOn));
  }
  autoSwitch.addEventListener('click', () => setSwitch(!autoTranslateOn));
  autoSwitch.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setSwitch(!autoTranslateOn); }
  });

  /* --------------------------------------------------------
   * Sidebar toggle
   * ------------------------------------------------------ */
  function applySidebar(visible) {
    mainEl.classList.toggle('aside-hidden', !visible);
    asideToggle.setAttribute('aria-expanded', String(visible));
  }
  asideToggle.addEventListener('click', () => {
    const visible = mainEl.classList.contains('aside-hidden');
    applySidebar(visible);
    try { localStorage.setItem(LS_SIDEBAR, visible ? '1' : '0'); } catch {}
  });
  // Ctrl+B / Cmd+B shortcut
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault(); asideToggle.click();
    }
  });
  try {
    const saved = localStorage.getItem(LS_SIDEBAR);
    applySidebar(saved === '1');
  } catch { applySidebar(false); }

  /* --------------------------------------------------------
   * Appearance
   * ------------------------------------------------------ */
  const DEFAULT_APPEARANCE = {
    theme: 'dark',
    size: 'md',
    accent: '#d9a84b',
    font: '"JetBrains Mono", ui-monospace, monospace'
  };

  function loadAppearance() {
    try {
      const raw = localStorage.getItem(LS_APPEARANCE);
      if (raw) return { ...DEFAULT_APPEARANCE, ...JSON.parse(raw) };
    } catch {}
    return { ...DEFAULT_APPEARANCE };
  }
  function saveAppearance(a) {
    try { localStorage.setItem(LS_APPEARANCE, JSON.stringify(a)); } catch {}
  }

  function applyAppearance(a) {
    const root = document.documentElement;
    root.dataset.theme = a.theme;
    root.dataset.size  = a.size;
    root.style.setProperty('--accent', a.accent);
    root.style.setProperty('--accent-dim', darken(a.accent, 0.55));
    // Pick a legible ink color for the accent button (black on light accents, white on dark accents)
    root.style.setProperty('--accent-ink', relLuminance(a.accent) > 0.55 ? '#1a1205' : '#fafaf7');
    root.style.setProperty('--font', a.font);

    // Reflect into controls
    [...segTheme.children].forEach(b => b.classList.toggle('active', b.dataset.val === a.theme));
    [...segSize.children].forEach(b => b.classList.toggle('active', b.dataset.val === a.size));
    [...swatches.querySelectorAll('.swatch')].forEach(s =>
      s.classList.toggle('active', s.dataset.val.toLowerCase() === a.accent.toLowerCase()));
    accentPicker.value = a.accent;
    fontSel.value = a.font;
  }

  let appearance = loadAppearance();
  applyAppearance(appearance);

  function updateAppearance(patch) {
    appearance = { ...appearance, ...patch };
    applyAppearance(appearance);
    saveAppearance(appearance);
  }

  segTheme.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    updateAppearance({ theme: btn.dataset.val });
  });
  segSize.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    updateAppearance({ size: btn.dataset.val });
  });
  swatches.addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch'); if (!sw) return;
    updateAppearance({ accent: sw.dataset.val });
  });
  accentPicker.addEventListener('input', (e) => {
    updateAppearance({ accent: e.target.value });
  });
  fontSel.addEventListener('change', (e) => {
    updateAppearance({ font: e.target.value });
  });
  resetAppearanceBtn.addEventListener('click', () => {
    updateAppearance({ ...DEFAULT_APPEARANCE });
  });

  /* --------------------------------------------------------
   * Config load / save
   * ------------------------------------------------------ */
  async function loadState() {
    try {
      const [cfgRes, statusRes] = await Promise.all([
        fetch('/api/config').then(r => r.json()),
        fetch('/api/status').then(r => r.json())
      ]);
      playerNameInput.value = cfgRes.playerName || '';
      logPathInput.value = cfgRes.logPath || '';
      cfgDirInput.value  = cfgRes.cfgDir || '';
      bindKeyInput.value = cfgRes.bindKey || '';
      autoTargetInput.value = (cfgRes.autoTranslateTarget || 'en').toLowerCase();
      tagCTInput.value = cfgRes.tagCT || 'CT';
      tagTInput.value  = cfgRes.tagT  || 'T';
      tagAllInput.value = cfgRes.tagAll || 'ALL';
      setSwitch(cfgRes.autoTranslate !== false);
      if (engineSelect) {
        const eng = (cfgRes.translationEngine === 'pollinations' || !cfgRes.translationEngine) ? 'smart' : cfgRes.translationEngine;
        engineSelect.value = eng;
      }
      if (geminiApiKeyInput) geminiApiKeyInput.value = cfgRes.geminiApiKey || '';
      if (groqApiKeyInput) groqApiKeyInput.value = cfgRes.groqApiKey || '';
      updateEngineUI();
      updateStatus(statusRes);
      if (statusRes.configPath) {
        cfgPathHint.textContent = 'config: ' + statusRes.configPath;
      }
    } catch (err) {
      setToast('Failed to load config: ' + err.message, 'err');
    }
  }

  function updateEngineUI() {
    const val = engineSelect ? engineSelect.value : 'smart';
    if (geminiKeyField) geminiKeyField.style.display = (val === 'gemini') ? 'block' : 'none';
    if (groqKeyField) groqKeyField.style.display = (val === 'groq') ? 'block' : 'none';
  }
  engineSelect?.addEventListener('change', updateEngineUI);

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const body = {
        playerName: playerNameInput.value.trim() || '',
        logPath: logPathInput.value.trim(),
        cfgDir:  cfgDirInput.value.trim(),
        bindKey: bindKeyInput.value.trim() || 'o',
        autoTranslate: autoTranslateOn,
        autoTranslateTarget: (autoTargetInput.value.trim() || 'hu').toLowerCase(),
        tagCT:  tagCTInput.value.trim() || 'CT',
        tagT:   tagTInput.value.trim()  || 'T',
        tagAll: tagAllInput.value.trim() || 'ALL',
        translationEngine: engineSelect ? engineSelect.value : 'smart',
        geminiApiKey: geminiApiKeyInput ? geminiApiKeyInput.value.trim() : '',
        groqApiKey: groqApiKeyInput ? groqApiKeyInput.value.trim() : ''
      };
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const saved = await res.json();
      setToast('Saved.', 'ok');
    } catch (err) {
      setToast('Save failed: ' + err.message, 'err');
    } finally {
      saveBtn.disabled = false;
    }
  });

  restartBtn.addEventListener('click', async () => {
    restartBtn.disabled = true;
    try {
      const res = await fetch('/api/restart', { method: 'POST' });
      const s = await res.json();
      updateStatus(s);
      setToast(s.watching ? 'Watcher restarted.' : 'Watcher idle.', s.watching ? 'ok' : 'err');
    } catch (err) {
      setToast('Restart failed: ' + err.message, 'err');
    } finally {
      restartBtn.disabled = false;
    }
  });

  function connectStream() {
    const es = new EventSource('/events');
    es.addEventListener('chat',    e => handleEvent(JSON.parse(e.data)));
    es.addEventListener('auto',    e => handleEvent(JSON.parse(e.data)));
    es.addEventListener('command', e => handleEvent(JSON.parse(e.data)));
    es.addEventListener('status',  e => handleEvent(JSON.parse(e.data)));
    es.addEventListener('error',   e => { try { handleEvent(JSON.parse(e.data)); } catch {} });
    es.addEventListener('cfg',     e => handleEvent(JSON.parse(e.data)));
    es.onerror = () => {
      statusEl.classList.remove('on'); statusEl.classList.add('bad');
      statusLabel.textContent = 'reconnecting…';
    };
  }

  /* --------------------------------------------------------
   * In-game send bar
   * ------------------------------------------------------ */
  const sendForm = document.getElementById('sendForm');
  const sendLang = document.getElementById('sendLang');
  const sendTeam = document.getElementById('sendTeam');
  const sendInput = document.getElementById('sendInput');
  const sendBtn = document.getElementById('sendBtn');
  const sendFeedback = document.getElementById('sendFeedback');

  const LS_SEND_LANG = 'cs2ct.sendLang';
  const LS_SEND_TEAM = 'cs2ct.sendTeam';

  try {
    const savedLang = localStorage.getItem(LS_SEND_LANG);
    if (savedLang) sendLang.value = savedLang;
    const savedTeam = localStorage.getItem(LS_SEND_TEAM);
    if (savedTeam) sendTeam.value = savedTeam;
  } catch {}

  sendLang.addEventListener('change', () => {
    try { localStorage.setItem(LS_SEND_LANG, sendLang.value); } catch {}
  });

  sendTeam.addEventListener('change', () => {
    try { localStorage.setItem(LS_SEND_TEAM, sendTeam.value); } catch {}
  });

  sendForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = sendInput.value.trim();
    if (!text) return;

    const target = sendLang.value;
    const team = sendTeam.value === 'team';

    sendInput.value = '';
    sendBtn.disabled = true;
    sendFeedback.textContent = 'Fordítás és küldés…';
    sendFeedback.className = 'send-feedback';

    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, target, team })
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || ('HTTP ' + res.status));
      }
      const data = await res.json();
      sendFeedback.textContent = '✅ Elküldve in-game: ' + data.translated;
      sendFeedback.className = 'send-feedback ok';

      // Also notify host WPF desktop window directly if running inside WebView2
      try {
        if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
          window.chrome.webview.postMessage({ type: 'sendKey', key: 'o' });
        }
      } catch {}

      setTimeout(() => {
        if (sendFeedback.className.includes('ok')) sendFeedback.textContent = '';
      }, 4500);
    } catch (err) {
      sendInput.value = text;
      sendFeedback.textContent = '❌ Hiba: ' + err.message;
      sendFeedback.className = 'send-feedback err';
      sendInput.focus();
    } finally {
      sendBtn.disabled = false;
    }
  });

  /* --------------------------------------------------------
   * Phone / QR Modal
   * ------------------------------------------------------ */
  const phoneBtn = document.getElementById('phoneBtn');
  const qrModal = document.getElementById('qrModal');
  const qrCloseBtn = document.getElementById('qrCloseBtn');
  const qrCodeContainer = document.getElementById('qrCodeContainer');
  const qrUrlInput = document.getElementById('qrUrlInput');
  const qrCopyBtn = document.getElementById('qrCopyBtn');

  async function openPhoneModal() {
    qrModal.classList.remove('hidden');
    try {
      const res = await fetch('/api/network-info').then(r => r.json());
      qrUrlInput.value = res.url;
      if (res.qrSvg) {
        qrCodeContainer.innerHTML = res.qrSvg;
      } else {
        qrCodeContainer.textContent = res.url;
      }
    } catch {
      qrUrlInput.value = window.location.href;
    }
  }

  phoneBtn?.addEventListener('click', openPhoneModal);
  qrCloseBtn?.addEventListener('click', () => qrModal.classList.add('hidden'));
  qrModal?.addEventListener('click', (e) => {
    if (e.target === qrModal) qrModal.classList.add('hidden');
  });

  qrCopyBtn?.addEventListener('click', () => {
    navigator.clipboard.writeText(qrUrlInput.value).then(() => {
      qrCopyBtn.textContent = 'Másolva!';
      setTimeout(() => { qrCopyBtn.textContent = 'Másolás'; }, 2000);
    });
  });

  loadState().then(connectStream);
</script>
</body>
</html>`;

function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    req.setEncoding("utf8");
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) { req.destroy(); reject(new Error("body too large")); }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function startWebServer(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    // UI
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(INDEX_HTML);
      return;
    }

    // SSE
    if (req.method === "GET" && p === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.write(":ok\n\n");
      // Snapshot current status + replay recent events so new clients get context
      res.write(
        `event: status\ndata: ${JSON.stringify({ type: "status", payload: statusSnapshot(), at: Date.now() })}\n\n`
      );
      const tail = recentEvents.slice(-60);
      for (const evt of tail) {
        res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
      }
      sseClients.add(res);
      const keepAlive = setInterval(() => {
        try { res.write(":keepalive\n\n"); } catch { /* noop */ }
      }, 20000);
      req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
      });
      return;
    }

    // Config: GET
    if (req.method === "GET" && p === "/api/config") {
      sendJson(res, loadConfig());
      return;
    }

    // Config: POST
    if (req.method === "POST" && p === "/api/config") {
      try {
        const body = await readJsonBody(req);
        const next = {
          logPath: typeof body.logPath === "string" ? body.logPath : undefined,
          cfgDir: typeof body.cfgDir === "string" ? body.cfgDir : undefined,
          bindKey: typeof body.bindKey === "string" ? body.bindKey : undefined,
          autoTranslate:
            typeof body.autoTranslate === "boolean" ? body.autoTranslate : undefined,
          autoTranslateTarget:
            typeof body.autoTranslateTarget === "string"
              ? body.autoTranslateTarget
              : undefined,
          tagCT: typeof body.tagCT === "string" ? body.tagCT : undefined,
          tagT: typeof body.tagT === "string" ? body.tagT : undefined,
          tagAll: typeof body.tagAll === "string" ? body.tagAll : undefined,
          playerName: typeof body.playerName === "string" ? body.playerName : undefined,
          translationEngine: typeof body.translationEngine === "string" ? body.translationEngine : undefined,
          geminiApiKey: typeof body.geminiApiKey === "string" ? body.geminiApiKey : undefined,
          groqApiKey: typeof body.groqApiKey === "string" ? body.groqApiKey : undefined
        };
        const cur = loadConfig();
        const merged = saveConfig({ ...cur, ...Object.fromEntries(
          Object.entries(next).filter(([, v]) => v !== undefined)
        )});
        setupFromConfig();
        startWatching();
        broadcast("status", statusSnapshot());
        sendJson(res, merged);
      } catch (err) {
        sendJson(res, { error: err.message }, 400);
      }
      return;
    }

    // Status
    if (req.method === "GET" && p === "/api/status") {
      sendJson(res, statusSnapshot());
      return;
    }

    // Restart watcher
    if (req.method === "POST" && p === "/api/restart") {
      setupFromConfig();
      startWatching();
      sendJson(res, statusSnapshot());
      return;
    }

    // Graceful shutdown (used by desktop app to clean up stale instances)
    if (req.method === "POST" && p === "/api/shutdown") {
      sendJson(res, { ok: true });
      setTimeout(() => {
        try { server.close(); } catch {}
        process.exit(0);
      }, 50);
      return;
    }

    // Send in-game chat from web UI
    if (req.method === "POST" && p === "/api/send") {
      try {
        const body = await readJsonBody(req);
        const text = String(body.text || "").trim();
        const target = String(body.target || "ru").toLowerCase();
        const team = !!body.team;
        const skipKey = !!body.skipKey;

        if (!text) {
          sendJson(res, { error: "A megadott szöveg üres" }, 400);
          return;
        }

        const resTr = await smartTranslate(text, target);
        const translated = resTr.text || text;

        writeChatCfg({ message: translated, team });
        setTimeout(pressBindKey, 150);

        log(
          sym.trans,
          chalk.green(`[Web küldés] [${team ? "TEAM" : "ALL"}] (${target}): `) +
            chalk.white(text) +
            chalk.gray(` → `) +
            chalk.cyan(translated)
        );

        sendJson(res, {
          ok: true,
          original: text,
          translated,
          target,
          team,
          bindKey: BIND_KEY
        });
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
      return;
    }

    // PWA Manifest
    if (req.method === "GET" && p === "/manifest.json") {
      sendJson(res, {
        name: "CS2 Chat Translator",
        short_name: "CS2 Chat",
        start_url: "/",
        display: "standalone",
        background_color: "#0b0b0c",
        theme_color: "#0b0b0c",
        description: "Counter-Strike 2 Chat Translator & Mobile Remote"
      });
      return;
    }

    // Network & QR code info for mobile pairing
    if (req.method === "GET" && p === "/api/network-info") {
      try {
        const ip = getLocalIpAddress();
        const mobileUrl = `http://${ip}:${port}`;
        let qrSvg = "";
        try {
          qrSvg = await QRCode.toString(mobileUrl, { type: "svg", margin: 1 });
        } catch {}
        sendJson(res, { ip, port, url: mobileUrl, qrSvg });
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.on("error", (err) => {
    console.error(chalk.red(`HTTP server error: ${err.message}`));
  });

  server.listen(port, "0.0.0.0", () => {
    const localUrl = `http://127.0.0.1:${port}`;
    const networkUrl = `http://${getLocalIpAddress()}:${port}`;
    console.log(sym.start, chalk.bold(`CS2 Chat Translator`));
    console.log(sym.info, `Local GUI:   ${chalk.underline(localUrl)}`);
    console.log(sym.info, `Mobile / LAN: ${chalk.underline(networkUrl)}`);
    console.log(chalk.gray(`   config: ${CONFIG_PATH}`));
  });

  return server;
}

function openBrowser(url) {
  // Linux-first (xdg-open), with macOS/Windows fallbacks in case someone runs it there.
  const cmd =
    process.platform === "darwin" ? `open "${url}"`
    : process.platform === "win32" ? `cmd /c start "" "${url}"`
    : `xdg-open "${url}"`;
  execChild(cmd, (err) => {
    if (err) log(sym.warn, chalk.yellow(`Could not auto-open browser: ${err.message}`));
  });
}

// -----------------------------------------------------------------------------
// CLI parsing and startup
// -----------------------------------------------------------------------------

function printCliHelp() {
  console.log("CS2 Chat Translator (CLI + Web GUI)");
  console.log("");
  console.log("Usage:");
  console.log("  cs2-chat-translator                 # start watcher + web GUI");
  console.log("  cs2-chat-translator --no-browser    # do not auto-open browser");
  console.log("  cs2-chat-translator --port 1234     # change web GUI port (default 7420)");
  console.log("  cs2-chat-translator --cli           # headless mode (no web GUI)");
  console.log("  cs2-chat-translator --init-config   # create/refresh config.json");
  console.log("  cs2-chat-translator --set-log-path /path/to/console.log");
  console.log("  cs2-chat-translator --set-cfg-dir  /path/to/cfg");
  console.log("  cs2-chat-translator --set-bind-key l");
  console.log("");
  console.log("In-game commands:");
  console.log("  tm_<lang> TEXT    translate TEXT to <lang> (e.g. tm_de hello)");
  console.log("  _tl [lang]        translate last message to [lang] (default en)");
  console.log("  code_<language>   show helper like 'For French use tm_fr'");
}

async function startAll({ withGui, port, openUi }) {
  setupFromConfig();
  startWatching();

  if (withGui) {
    startWebServer(port);
    if (openUi) setTimeout(() => openBrowser(`http://127.0.0.1:${port}`), 250);
  } else {
    // Headless banner for --cli
    console.log(sym.start, chalk.bold(`CS2 Chat Translator (headless)\n`));
    console.log(chalk.gray("Commands: tm_<lang> TEXT | _tl [lang] | code_<lang>"));
  }
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  printCliHelp();
  process.exit(0);
}

if (args[0] === "--init-config") {
  initConfigCli();
  process.exit(0);
}

if (args[0] === "--set-log-path" && args[1]) {
  updateConfigKey("logPath", path.resolve(args[1]));
  process.exit(0);
}

if (args[0] === "--set-cfg-dir" && args[1]) {
  updateConfigKey("cfgDir", path.resolve(args[1]));
  process.exit(0);
}

if (args[0] === "--set-bind-key" && args[1]) {
  updateConfigKey("bindKey", args[1]);
  process.exit(0);
}

// Default mode: start watcher (+ GUI unless --cli)
const portArgIdx = args.indexOf("--port");
const port = portArgIdx !== -1 && args[portArgIdx + 1]
  ? Number(args[portArgIdx + 1])
  : 7420;
const withGui = !args.includes("--cli");
const openUi = withGui && !args.includes("--no-browser");

startAll({ withGui, port, openUi }).catch((err) => {
  console.error(chalk.red("Fatal error:"), err);
  process.exit(1);
});
