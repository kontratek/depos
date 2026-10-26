import * as vscode from 'vscode';

/** Single output channel — makes "is it even running?" answerable (View → Output → Depos). */
export const log = vscode.window.createOutputChannel('Depos');

export function logInfo(message: string): void {
  log.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function logError(scope: string, err: unknown): void {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  log.appendLine(`[${new Date().toISOString()}] ERROR in ${scope}: ${detail}`);
}
