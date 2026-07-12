type LogLevel = "info" | "warn" | "error";

type LogContext = Record<string, unknown>;

function write(level: LogLevel, message: string, context: LogContext = {}): void {
  console.log(
    JSON.stringify({
      level,
      message,
      ...context,
      timestamp: new Date().toISOString(),
    }),
  );
}

export function logInfo(message: string, context?: LogContext): void {
  write("info", message, context);
}

export function logWarn(message: string, context?: LogContext): void {
  write("warn", message, context);
}

export function logError(message: string, context?: LogContext): void {
  write("error", message, context);
}
