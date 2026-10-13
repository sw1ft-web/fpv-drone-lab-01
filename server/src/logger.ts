/** The tiny structured-logging interface the server needs; `console` and test doubles both fit. */
export interface Logger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** One JSON object per line on stdout/stderr. */
export const consoleLogger: Logger = {
  info: (fields, message) =>
    console.log(JSON.stringify({ level: "info", message, ...fields })),
  warn: (fields, message) =>
    console.warn(JSON.stringify({ level: "warn", message, ...fields })),
  error: (fields, message) => {
    const { err, ...rest } = fields;
    console.error(
      JSON.stringify({
        level: "error",
        message,
        ...rest,
        err: err instanceof Error ? (err.stack ?? err.message) : err,
      }),
    );
  },
};

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};
