/**
 * logger.ts
 * Winston logger configured for structured JSON output with daily rotation.
 * All modules import this singleton.
 */

import * as winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { CONFIG } from './config';
import * as fs from 'fs';

// Ensure log directory exists
if (!fs.existsSync(CONFIG.LOG_DIR)) {
  fs.mkdirSync(CONFIG.LOG_DIR, { recursive: true });
}

const { combine, timestamp, json, colorize, printf } = winston.format;

// Human-readable format for console during development
const consoleFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss.SSS' }),
  printf(({ level, message, timestamp: ts, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `[${ts}] ${level}: ${message}${metaStr}`;
  }),
);

// Structured JSON for file — queryable with jq, Cloudwatch Insights, etc.
const fileFormat = combine(
  timestamp(),
  json(),
);

const transport_console = new winston.transports.Console({
  level: CONFIG.LOG_LEVEL,
  format: consoleFormat,
});

const transport_combined = new DailyRotateFile({
  filename:       `${CONFIG.LOG_DIR}/bot-%DATE%.log`,
  datePattern:    'YYYY-MM-DD',
  maxFiles:       '14d',
  level:          CONFIG.LOG_LEVEL,
  format:         fileFormat,
});

const transport_error = new DailyRotateFile({
  filename:       `${CONFIG.LOG_DIR}/error-%DATE%.log`,
  datePattern:    'YYYY-MM-DD',
  maxFiles:       '30d',
  level:          'error',
  format:         fileFormat,
});

const transport_trades = new DailyRotateFile({
  filename:       `${CONFIG.LOG_DIR}/trades-%DATE%.log`,
  datePattern:    'YYYY-MM-DD',
  maxFiles:       '365d',        // keep a full year of trade records
  level:          'info',
  format:         fileFormat,
});

export const logger = winston.createLogger({
  transports: [transport_console, transport_combined, transport_error],
  exitOnError: false,
});

// A dedicated logger for trade records — never silenced by LOG_LEVEL
export const tradeLogger = winston.createLogger({
  transports: [transport_trades],
  exitOnError: false,
});

// Unhandled rejection guard
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  // Give logger time to flush before exit
  setTimeout(() => process.exit(1), 500);
});
