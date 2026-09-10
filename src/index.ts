#!/usr/bin/env node
// Type-only imports are erased at runtime — safe to keep static.
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import type * as http from 'node:http';
import process from 'node:process';

import * as z from 'zod/v4';

import { CliExitError, parseArgs, runPrintConfig } from './cli.js';
import { NO_POSITIONAL_ROOTS_GUIDANCE } from './core/config.js';
import { logRuntimeFailure } from './core/observability.js';
import { startHttpServer, startServer } from './transport.js';

z.config(z.locales.en());

const SHUTDOWN_TIMEOUT_MS = 5000;
let activeStdioHandle: StdioServerHandle | undefined;
let activeHttpServer: http.Server | undefined;
let shutdownStarted = false;

function isStdinEvent(event: NodeJS.Signals | 'end' | 'close'): boolean {
  return event === 'end' || event === 'close';
}

function registerShutdownTrigger(event: NodeJS.Signals | 'end' | 'close'): void {
  const target = isStdinEvent(event) ? process.stdin : process;
  target.once(event, () => {
    const reason = isStdinEvent(event) ? `stdin ${event}` : event;
    void shutdown(reason, 0);
  });
}

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shutdownStarted) {
    if (reason === 'SIGINT' || reason === 'SIGTERM') {
      process.exit(130);
    }
    return;
  }
  shutdownStarted = true;

  process.exitCode = exitCode;

  const timer = setTimeout(() => {
    logRuntimeFailure(
      'shutdown_timeout',
      'process',
      'shutdown',
      `Shutdown timed out (${reason}), forcing exit.`,
    );
    process.exit(exitCode);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();

  try {
    try {
      await activeHttpServer?.[Symbol.asyncDispose]();
    } catch (error: unknown) {
      logRuntimeFailure('shutdown_http_error', 'process', 'shutdown', error);
    }
    try {
      await activeStdioHandle?.close();
    } catch (error: unknown) {
      logRuntimeFailure('shutdown_mcp_error', 'process', 'shutdown', error);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  let parsed: Awaited<ReturnType<typeof parseArgs>>;
  try {
    parsed = await parseArgs();
  } catch (error: unknown) {
    if (error instanceof CliExitError) {
      if (error.message.length > 0) {
        logRuntimeFailure('cli_exit', 'startup', 'parse_args', error.message);
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const { allowedDirs, allowCwd, port, readOnly, printConfig, json, httpHost, apiKey } = parsed;

  if (printConfig) {
    await runPrintConfig({
      allowedDirs,
      allowCwd,
      readOnly,
      json,
      ...(port !== undefined ? { port } : {}),
      ...(httpHost !== undefined ? { httpHost } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
    return;
  }

  if (allowedDirs.length > 0) {
    console.error('Allowed directories (from CLI):');
    for (const dir of allowedDirs) {
      console.error(`- ${dir}`);
    }
  } else {
    console.error(NO_POSITIONAL_ROOTS_GUIDANCE);
  }

  if (readOnly) {
    console.error('Read-only mode: mutating tools disabled.');
  }

  const serverOptions = { allowCwd, cliAllowedDirs: allowedDirs, readOnly };
  const runtimeConfig = {
    ...(httpHost !== undefined ? { httpHost } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
  };

  if (port !== undefined) {
    activeHttpServer = await startHttpServer(port, serverOptions, runtimeConfig);
  } else {
    registerShutdownTrigger('end');
    registerShutdownTrigger('close');
    activeStdioHandle = startServer(serverOptions, runtimeConfig);
  }
}

registerShutdownTrigger('SIGTERM');
registerShutdownTrigger('SIGINT');

process.once('unhandledRejection', (reason: unknown) => {
  logRuntimeFailure('unhandled_rejection', 'process', 'unhandledRejection', reason);
  void shutdown('unhandledRejection', 1);
});

process.once('uncaughtException', (error: Error) => {
  logRuntimeFailure('uncaught_exception', 'process', 'uncaughtException', error);
  void shutdown('uncaughtException', 1);
});

main().catch((error: unknown) => {
  logRuntimeFailure('fatal', 'startup', 'main', error);
  void shutdown('fatal', 1);
});
