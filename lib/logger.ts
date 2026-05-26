type LogLevel = "info" | "warn" | "error" | "debug";

interface LogMeta {
  [key: string]: unknown;
}

function log(level: LogLevel, scope: string, message: string, meta?: LogMeta) {
  const ts = new Date().toISOString();
  const prefix = `[FanDraft:${scope}]`;
  const line = meta
    ? `${ts} ${prefix} ${message} ${JSON.stringify(meta)}`
    : `${ts} ${prefix} ${message}`;

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level === "debug") console.debug(line);
  else console.log(line);
}

export const logger = {
  info:  (scope: string, message: string, meta?: LogMeta) => log("info",  scope, message, meta),
  warn:  (scope: string, message: string, meta?: LogMeta) => log("warn",  scope, message, meta),
  error: (scope: string, message: string, meta?: LogMeta) => log("error", scope, message, meta),
  debug: (scope: string, message: string, meta?: LogMeta) => log("debug", scope, message, meta),
};
