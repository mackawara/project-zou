import { inspect } from "node:util";

/**
 * Console logging shared by the web app and the worker, used like the ISP bot's logger.
 *
 * Outside production (`next dev`, the worker and tests unless NODE_ENV=production) errors are
 * logged in full: message, stack, `cause` chain and every property, such as a MongoDB server
 * response or a Graph API error body. In production only the error's name and code follow the
 * message, because driver and API error messages can quote stored personal data.
 */
const development = () => process.env.NODE_ENV !== "production";

function describe(error: unknown) {
  if (development()) return inspect(error, { depth: null, colors: !!process.stderr.isTTY });
  if (!(error instanceof Error)) return typeof error;
  const code = (error as { code?: unknown }).code;
  return code === undefined ? error.name : `${error.name} ${String(code)}`;
}

const write = (level: "info" | "warn" | "error") => (message: string, error?: unknown) => {
  if (error === undefined) console[level](message);
  else if (development()) console[level](`${message}\n${describe(error)}`);
  else console[level](`${message} (${describe(error)})`);
};

export const logger = {
  info: write("info"),
  warn: write("warn"),
  error: write("error"),
  /** Only with WA_DEBUG=1: raw webhook bodies and signature details, never the app secret itself. */
  debug: (message: string, ...details: unknown[]) => {
    if (process.env.WA_DEBUG === "1") console.log(`[wa-debug] ${message}`, ...details);
  },
  debugEnabled: () => process.env.WA_DEBUG === "1",
};
