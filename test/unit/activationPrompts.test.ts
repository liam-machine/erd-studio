/**
 * One prompt per window session (src/services/activationPrompts.ts): which
 * activation prompt wins, and the gate activation and the canvas share.
 * Activation's end to end: `extension.activate.test.ts` → "one activation
 * prompt per window"; the canvas offers: `convertProjectToDbml.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { ACTIVATION_PROMPT_PRIORITY, pickActivationPrompt, SessionPromptGate } from '../../src/services/activationPrompts';

describe('pickActivationPrompt', () => {
  it('a project with diagrams opens one; an empty folder gets the walkthrough', () => {
    expect(pickActivationPrompt(['walkthrough', 'diagramsNudge', 'harnessInstall'])).toBe('diagramsNudge');
    expect(pickActivationPrompt(['harnessInstall', 'walkthrough'])).toBe('walkthrough');
  });

  it('keeping the project working comes before news and set-up offers', () => {
    expect(pickActivationPrompt(['upgradeNotice', 'harnessUpdate'])).toBe('harnessUpdate');
    expect(pickActivationPrompt(['harnessInstall', 'migrateToV5', 'upgradeNotice'])).toBe('migrateToV5');
    expect(pickActivationPrompt(['saveLayers', 'harnessInstall', 'upgradeNotice'])).toBe('upgradeNotice');
    expect(pickActivationPrompt(['saveLayers', 'harnessInstall'])).toBe('harnessInstall');
    expect(pickActivationPrompt(['saveLayers'])).toBe('saveLayers');
  });

  it('nothing offered, nothing shown; the canvas offers are never picked at activation', () => {
    expect(pickActivationPrompt([])).toBeUndefined();
    expect(pickActivationPrompt(['dbmlConversion', 'namingMigration'])).toBeUndefined();
    expect(ACTIVATION_PROMPT_PRIORITY).toEqual([
      'diagramsNudge', 'startSuggestion', 'walkthrough', 'harnessUpdate', 'migrateToV5', 'upgradeNotice', 'harnessInstall', 'saveLayers',
    ]);
  });
});

describe('SessionPromptGate', () => {
  it('the first claim wins until reset', () => {
    const gate = new SessionPromptGate();
    expect(gate.claimed).toBeUndefined();
    expect(gate.claim('diagramsNudge')).toBe(true);
    expect(gate.claim('dbmlConversion')).toBe(false);
    expect(gate.claim('diagramsNudge')).toBe(false);
    expect(gate.claimed).toBe('diagramsNudge');
    gate.reset();
    expect(gate.claim('dbmlConversion')).toBe(true);
    expect(gate.claimed).toBe('dbmlConversion');
  });
});

describe('SessionPromptGate.reserve: a start on screen keeps the window', () => {
  it('holds a free session at once', () => {
    const gate = new SessionPromptGate();
    gate.reserve('draft');
    expect(gate.claimed).toBe('draft');
    expect(gate.claim('harnessInstall')).toBe(false);
  });

  it('a draft opened while the start suggestion is still looking takes the window when the look hands it on', () => {
    const gate = new SessionPromptGate();
    expect(gate.claim('startSuggestion')).toBe(true);
    gate.reserve('draft');
    expect(gate.claimed).toBe('startSuggestion');
    // The look found nothing concrete: the window is the draft's, not the AI helper offer's.
    gate.release('startSuggestion');
    expect(gate.claimed).toBe('draft');
    expect(gate.claim('harnessInstall')).toBe(false);
    expect(gate.claim('upgradeNotice')).toBe(false);
  });

  it('the first diagram made in a window keeps it too; a holder that shows stays the holder', () => {
    const gate = new SessionPromptGate();
    expect(gate.claim('startSuggestion')).toBe(true);
    gate.reserve('firstDiagram');
    gate.reserve('draft');
    gate.release('startSuggestion');
    expect(gate.claimed).toBe('firstDiagram');
    gate.release('draft');
    expect(gate.claimed).toBe('firstDiagram');
    gate.reset();
    expect(gate.claim('saveLayers')).toBe(true);
  });
});
