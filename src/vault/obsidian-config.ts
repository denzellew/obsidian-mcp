import { existsSync, readFileSync } from "node:fs";
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
