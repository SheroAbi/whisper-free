import log from 'electron-log/main'
import { app } from 'electron'
import path from 'node:path'
import type { LogPayload } from '../shared/ipc'

/**
 * Central logger. Wraps electron-log (rotating file + console) and fans out a
 * trimmed copy of every line to any subscriber (the diagnostics panel listens
 * so users can watch logs live without opening the file).
 */

type Level = 'debug' | 'info' | 'warn' | 'error'
type Sink = (l: LogPayload) => void

const sinks = new Set<Sink>()

let initialized = false

export function initLogger(): void {
  if (initialized) return
  initialized = true
  log.initialize()
  log.transports.file.level = 'debug'
  log.transports.console.level = 'debug'
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.file.fileName = 'whisper-free.log'
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
  // Surface uncaught errors instead of silently dying.
  log.errorHandler.startCatching({ showDialog: false })
  log.info('logger initialized', { version: app.getVersion() })
}

export function getLogFilePath(): string {
  try {
    return log.transports.file.getFile().path
  } catch {
    return path.join(app.getPath('logs'), 'whisper-free.log')
  }
}

function emit(level: Level, scope: string, message: string): void {
  const payload: LogPayload = { level, scope, message, ts: Date.now() }
  for (const sink of sinks) {
    try {
      sink(payload)
    } catch {
      /* never let a UI sink break logging */
    }
  }
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

export interface ScopedLogger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export function createLogger(scope: string): ScopedLogger {
  const tag = `[${scope}]`
  return {
    debug: (...a) => {
      log.debug(tag, ...a)
      emit('debug', scope, fmt(a))
    },
    info: (...a) => {
      log.info(tag, ...a)
      emit('info', scope, fmt(a))
    },
    warn: (...a) => {
      log.warn(tag, ...a)
      emit('warn', scope, fmt(a))
    },
    error: (...a) => {
      log.error(tag, ...a)
      emit('error', scope, fmt(a))
    }
  }
}

export function subscribeLogs(sink: Sink): () => void {
  sinks.add(sink)
  return () => sinks.delete(sink)
}
