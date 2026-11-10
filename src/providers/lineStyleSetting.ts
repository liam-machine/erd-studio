/**
 * The `erdStudio.canvas.lineStyle` setting: how every canvas draws its
 * relationship lines (`src/types/lineStyle.ts`). The toolbar's Curved / Hops
 * switch writes it at user (Global) scope through the webview's
 * `setLineStyle`; each open canvas is told the value with `lineStyle` when it
 * says `ready` and whenever the setting changes. Never writes a project file.
 */
import * as vscode from 'vscode';

import { getErdStudioSetting } from '../services/configService';
import {
  DEFAULT_CANVAS_LINE_STYLE,
  LINE_STYLE_SETTING,
  isCanvasLineStyle,
  type CanvasLineStyle,
} from '../types/lineStyle';

/** The setting as it stands (anything but a known style reads as the default). */
export function readLineStyle(): CanvasLineStyle {
  const value = getErdStudioSetting<unknown>(LINE_STYLE_SETTING, DEFAULT_CANVAS_LINE_STYLE);
  return isCanvasLineStyle(value) ? value : DEFAULT_CANVAS_LINE_STYLE;
}

/** Write the setting at user scope: a view preference follows the reader to every project. */
export async function writeLineStyle(style: CanvasLineStyle): Promise<void> {
  await vscode.workspace
    .getConfiguration('erdStudio')
    .update(LINE_STYLE_SETTING, style, vscode.ConfigurationTarget.Global);
}

/** Whether a configuration change touches the setting. */
export function affectsLineStyle(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration(`erdStudio.${LINE_STYLE_SETTING}`);
}
