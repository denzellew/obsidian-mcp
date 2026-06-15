import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface DailyNotesConfig {
  enabled: boolean;
  folder: string;
  format: string; // moment format, default "YYYY-MM-DD"
  template: string | null; // vault-relative template path
}

export interface ObsidianSettings {
  dailyNotes: DailyNotesConfig;
  templatesFolder: string | null;
  attachmentFolder: string;
  newLinkFormat: "shortest" | "relative" | "absolute";
  useMarkdownLinks: boolean;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Read the parts of .obsidian/ that affect where and how we write. Re-read per call (cheap, sync daemon may change them). */
export function readObsidianSettings(vaultDir: string): ObsidianSettings {
  const dir = join(vaultDir, ".obsidian");
  const daily = readJson(join(dir, "daily-notes.json")) ?? {};
  const templates = readJson(join(dir, "templates.json")) ?? {};
  const app = readJson(join(dir, "app.json")) ?? {};
  const corePlugins = readJson(join(dir, "core-plugins.json"));

  let dailyEnabled = true; // daily-notes is enabled by default in Obsidian
  if (corePlugins) {
    if (Array.isArray(corePlugins)) dailyEnabled = (corePlugins as unknown as string[]).includes("daily-notes");
    else if (typeof (corePlugins as Record<string, unknown>)["daily-notes"] === "boolean")
      dailyEnabled = Boolean((corePlugins as Record<string, unknown>)["daily-notes"]);
  }

  const fmt = typeof daily.format === "string" && daily.format.trim() ? (daily.format as string) : "YYYY-MM-DD";
  let template = typeof daily.template === "string" && daily.template.trim() ? (daily.template as string) : null;
  if (template && !/\.md$/i.test(template)) template += ".md";

  const newLinkFormat = ["shortest", "relative", "absolute"].includes(app.newLinkFormat as string)
    ? (app.newLinkFormat as "shortest" | "relative" | "absolute")
    : "shortest";

  return {
    dailyNotes: {
      enabled: dailyEnabled,
      folder: typeof daily.folder === "string" ? (daily.folder as string).replace(/^\/+|\/+$/g, "") : "",
      format: fmt,
      template,
    },
    templatesFolder:
      typeof templates.folder === "string" && templates.folder.trim()
        ? (templates.folder as string).replace(/^\/+|\/+$/g, "")
        : null,
    attachmentFolder:
      typeof app.attachmentFolderPath === "string" ? (app.attachmentFolderPath as string) : "",
    newLinkFormat,
    useMarkdownLinks: app.useMarkdownLinks === true,
  };
}

export interface CommunityPluginInfo {
  id: string;
  name: string;
  version: string | null;
  description: string | null;
  author: string | null;
  enabled: boolean;
}

export interface VaultConfigReport {
  /** Whether a .obsidian/ directory exists at all (config sync may be off). */
  present: boolean;
  /** Enabled core (built-in) plugin ids, e.g. "file-explorer", "daily-notes". */
  corePlugins: string[];
  /** Installed community plugins, each flagged with whether it is enabled. */
  communityPlugins: CommunityPluginInfo[];
  appearance: {
    /** "obsidian" (dark), "moonstone" (light), or "system". */
    mode: string | null;
    /** Active community theme name, or null for the default theme. */
    cssTheme: string | null;
    accentColor: string | null;
    baseFontSize: number | null;
    enabledCssSnippets: string[];
  };
  /** Command ids with a customized hotkey binding (the bindings themselves are omitted to stay light). */
  customizedHotkeys: string[];
}

/** Normalize core-plugins.json (array form OR { id: bool } object form) to enabled ids. */
function enabledCorePlugins(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
  }
  return [];
}

/**
 * Read the user's .obsidian/ configuration for *reporting* — plugins, theme,
 * hotkeys. This is read-only and only returns anything once config is present
 * in the vault (e.g. synced via Obsidian Sync's --configs). Every file is
 * optional; missing/corrupt files degrade to empty rather than throwing.
 */
export function readVaultConfig(vaultDir: string): VaultConfigReport {
  const dir = join(vaultDir, ".obsidian");
  const present = existsSync(dir);

  const corePlugins = enabledCorePlugins(readJson(join(dir, "core-plugins.json")));

  const communityRaw = readJson(join(dir, "community-plugins.json"));
  const enabledCommunity = new Set(
    (Array.isArray(communityRaw) ? communityRaw : []).filter((x): x is string => typeof x === "string"),
  );
  const communityPlugins: CommunityPluginInfo[] = [];
  const pluginsDir = join(dir, "plugins");
  if (existsSync(pluginsDir)) {
    let ids: string[] = [];
    try {
      ids = readdirSync(pluginsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {}
    for (const id of ids.sort()) {
      const manifest = readJson(join(pluginsDir, id, "manifest.json")) ?? {};
      communityPlugins.push({
        id,
        name: typeof manifest.name === "string" ? (manifest.name as string) : id,
        version: typeof manifest.version === "string" ? (manifest.version as string) : null,
        description: typeof manifest.description === "string" ? (manifest.description as string) : null,
        author: typeof manifest.author === "string" ? (manifest.author as string) : null,
        enabled: enabledCommunity.has(id),
      });
    }
  }
  // Plugins enabled in community-plugins.json but with no folder on disk (rare): still report them.
  for (const id of enabledCommunity) {
    if (!communityPlugins.some((p) => p.id === id)) {
      communityPlugins.push({ id, name: id, version: null, description: null, author: null, enabled: true });
    }
  }

  const appearance = (readJson(join(dir, "appearance.json")) ?? {}) as Record<string, unknown>;
  const hotkeys = (readJson(join(dir, "hotkeys.json")) ?? {}) as Record<string, unknown>;

  return {
    present,
    corePlugins: corePlugins.sort(),
    communityPlugins,
    appearance: {
      mode: typeof appearance.theme === "string" ? (appearance.theme as string) : null,
      cssTheme: typeof appearance.cssTheme === "string" && (appearance.cssTheme as string).trim() ? (appearance.cssTheme as string) : null,
      accentColor: typeof appearance.accentColor === "string" && (appearance.accentColor as string).trim() ? (appearance.accentColor as string) : null,
      baseFontSize: typeof appearance.baseFontSize === "number" ? (appearance.baseFontSize as number) : null,
      enabledCssSnippets: Array.isArray(appearance.enabledCssSnippets)
        ? (appearance.enabledCssSnippets as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
    },
    customizedHotkeys: Object.keys(hotkeys).sort(),
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Format a date with the subset of moment.js tokens Obsidian daily notes use.
 * Supports [literal] escapes and path separators. Throws on tokens we don't
 * implement so callers can produce a clear error instead of a wrong path.
 */
export function formatMoment(date: Date, format: string): string {
  let out = "";
  let i = 0;
  while (i < format.length) {
    const ch = format[i]!;
    if (ch === "[") {
      const close = format.indexOf("]", i);
      if (close === -1) throw new Error(`Unclosed [literal] in date format: ${format}`);
      out += format.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    const rest = format.slice(i);
    const m = rest.match(/^(YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|hh|h|mm|m|ss|s|A|a|Q)/);
    if (m) {
      out += formatToken(date, m[1]!);
      i += m[1]!.length;
      continue;
    }
    if (/^[A-Za-z]/.test(ch)) {
      throw new Error(
        `Unsupported date-format token at "${rest.slice(0, 6)}" in "${format}". Supported: YYYY YY MMMM MMM MM M DD D dddd ddd HH H hh h mm m ss s A a Q and [literals].`,
      );
    }
    out += ch;
    i++;
  }
  return out;
}

function formatToken(d: Date, token: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  switch (token) {
    case "YYYY": return String(d.getFullYear());
    case "YY": return pad(d.getFullYear() % 100);
    case "MMMM": return MONTHS[d.getMonth()]!;
    case "MMM": return MONTHS[d.getMonth()]!.slice(0, 3);
    case "MM": return pad(d.getMonth() + 1);
    case "M": return String(d.getMonth() + 1);
    case "DD": return pad(d.getDate());
    case "D": return String(d.getDate());
    case "dddd": return DAYS[d.getDay()]!;
    case "ddd": return DAYS[d.getDay()]!.slice(0, 3);
    case "HH": return pad(d.getHours());
    case "H": return String(d.getHours());
    case "hh": return pad(d.getHours() % 12 || 12);
    case "h": return String(d.getHours() % 12 || 12);
    case "mm": return pad(d.getMinutes());
    case "m": return String(d.getMinutes());
    case "ss": return pad(d.getSeconds());
    case "s": return String(d.getSeconds());
    case "A": return d.getHours() < 12 ? "AM" : "PM";
    case "a": return d.getHours() < 12 ? "am" : "pm";
    case "Q": return String(Math.floor(d.getMonth() / 3) + 1);
    default: throw new Error(`Unsupported token ${token}`);
  }
}

/** Vault-relative path of the daily note for a date, per vault settings. */
export function dailyNotePath(settings: ObsidianSettings, date: Date): string {
  const name = formatMoment(date, settings.dailyNotes.format);
  const folder = settings.dailyNotes.folder;
  return `${folder ? `${folder}/` : ""}${name}.md`;
}

/** Apply Obsidian template variables ({{date}}, {{time}}, {{title}}, {{date:FMT}}). */
export function applyTemplateVars(template: string, title: string, now = new Date()): string {
  return template.replace(/\{\{(date|time|title)(?::([^}]+))?\}\}/gi, (_all, name: string, fmt?: string) => {
    switch (name.toLowerCase()) {
      case "title": return title;
      case "date": return formatMoment(now, fmt || "YYYY-MM-DD");
      case "time": return formatMoment(now, fmt || "HH:mm");
      default: return _all as string;
    }
  });
}
