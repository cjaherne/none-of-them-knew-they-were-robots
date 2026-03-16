import type { LogLevel, LogCategory, LogEntry } from "./types";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

export interface LogTransport {
  write(entry: LogEntry): void;
}

let _globalLevel: LogLevel = "INFO";
const _globalTransports: LogTransport[] = [];

export class ConsoleTransport implements LogTransport {
  write(entry: LogEntry): void {
    const prefix = `[${entry.timestamp}] [${entry.level}] [${entry.source}]`;
    const cat = entry.category ? ` (${entry.category})` : "";
    const line = `${prefix}${cat} ${entry.message}`;
    const meta = entry.metadata && Object.keys(entry.metadata).length > 0 ? entry.metadata : undefined;

    switch (entry.level) {
      case "ERROR":
        meta ? console.error(line, meta) : console.error(line);
        break;
      case "WARN":
        meta ? console.warn(line, meta) : console.warn(line);
        break;
      default:
        meta ? console.log(line, meta) : console.log(line);
        break;
    }
  }
}

let _idCounter = 0;
function generateId(): string {
  return `log-${Date.now()}-${++_idCounter}`;
}

export class Logger {
  private source: string;
  private transports: LogTransport[];
  private taskId?: string;

  constructor(source: string, transports?: LogTransport[], taskId?: string) {
    this.source = source;
    this.transports = transports ?? _globalTransports;
    this.taskId = taskId;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[_globalLevel];
  }

  private emit(level: LogLevel, message: string, metadata?: Record<string, unknown>, category?: LogCategory): LogEntry {
    const entry: LogEntry = {
      id: generateId(),
      taskId: this.taskId,
      timestamp: new Date().toISOString(),
      level,
      source: this.source,
      message,
      metadata,
      category,
    };
    for (const t of this.transports) {
      try { t.write(entry); } catch { /* transport failure must not crash */ }
    }
    return entry;
  }

  debug(message: string, metadata?: Record<string, unknown>, category?: LogCategory): LogEntry | undefined {
    if (!this.shouldLog("DEBUG")) return undefined;
    return this.emit("DEBUG", message, metadata, category);
  }

  info(message: string, metadata?: Record<string, unknown>, category?: LogCategory): LogEntry | undefined {
    if (!this.shouldLog("INFO")) return undefined;
    return this.emit("INFO", message, metadata, category);
  }

  warn(message: string, metadata?: Record<string, unknown>, category?: LogCategory): LogEntry | undefined {
    if (!this.shouldLog("WARN")) return undefined;
    return this.emit("WARN", message, metadata, category);
  }

  error(message: string, metadata?: Record<string, unknown>, category?: LogCategory): LogEntry | undefined {
    if (!this.shouldLog("ERROR")) return undefined;
    return this.emit("ERROR", message, metadata, category);
  }

  child(source: string, taskId?: string): Logger {
    return new Logger(source, this.transports, taskId ?? this.taskId);
  }

  withTask(taskId: string): Logger {
    return new Logger(this.source, this.transports, taskId);
  }
}

export function setGlobalLogLevel(level: LogLevel): void {
  _globalLevel = level;
}

export function getGlobalLogLevel(): LogLevel {
  return _globalLevel;
}

export function addGlobalTransport(transport: LogTransport): void {
  _globalTransports.push(transport);
}

export function createLogger(source: string, taskId?: string): Logger {
  return new Logger(source, _globalTransports, taskId);
}

addGlobalTransport(new ConsoleTransport());
