import {
  EXTENSION_MARKETPLACE_URL,
  EXTENSION_REPO_URL,
} from '../lib/setup.js';

export const get_editor_setup = {
  name: 'get_editor_setup',
  config: {
    title: 'How to set up the ERD Studio editor (for write/design workflows)',
    description:
      'Returns installation and setup instructions for the ERD Studio VS Code extension. ' +
      'This MCP server is read-only by design — for designing new ERDs, creating models, ' +
      'drawing relationships, generating dbt SQL, or any other write/edit workflow, the user ' +
      'should install the extension and use its bundled AI coding skill. Call this tool when ' +
      'the user asks about editing, designing, or building (i.e. anything beyond inspecting ' +
      'an existing model).',
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  async handler() {
    const text = [
      '# ERD Studio editor setup',
      '',
      'This MCP server provides **read-only** access to ERD Studio domain files.',
      'For write/design workflows (creating ERDs, adding models, drawing relationships,',
      'generating dbt SQL + schema YAML), use the ERD Studio VS Code extension and its',
      'bundled AI coding skill.',
      '',
      '## 1. Install the VS Code extension',
      '',
      `- Marketplace: ${EXTENSION_MARKETPLACE_URL}`,
      '- Quick install in VS Code: `Cmd+P` → `ext install liamwynne.erd-studio`',
      '',
      '## 2. Create the first diagram',
      '',
      'In VS Code, open Command Palette (`Cmd+Shift+P`) and run:',
      '',
      '```',
      'ERD Studio: New Subject Area',
      '```',
      '',
      'This creates `.erd-studio/` with `layers.json` and the diagram (a `.dbml` file in a layer folder); the table library (`tables/`, one `.dbml` file per table) comes with the first table.',
      '',
      '## 3. Set up your AI helper (writes the skill files)',
      '',
      'Command Palette → `ERD Studio: Set Up My AI Helper`. It installs the files for the assistants it finds:',
      '',
      '| Assistant | File written |',
      '|---|---|',
      '| Claude Code | `.claude/skills/erd-studio/SKILL.md` with `DBML.md`, `LEGACY.md` and `SYNC.md` (+ PreToolUse hook) |',
      '| Claude Code (setup walkthrough) | `.claude/skills/erd-studio-setup/` — run `/erd-studio-setup` in the project folder |',
      '| Agent Skills — GitHub Copilot, Codex, Gemini CLI, Cursor | `.agents/skills/erd-studio/SKILL.md` + `.agents/skills/erd-studio-setup/` — `/erd-studio-setup` (Copilot, Cursor), `$erd-studio-setup` (Codex), or ask Gemini CLI to "Set up ERD Studio for this project" |',
      '| GitHub Copilot | `.github/instructions/erd-studio.instructions.md` |',
      '| Google Gemini | `.gemini/styleguide.md` |',
      '| OpenAI Codex | `AGENTS.md` (appended) |',
      '',
      'It installs the guided setup for whichever of those assistants it finds (both skill folders when it finds none).',
      '',
      'The skills provide deeper write integration than this MCP server — multi-file edits,',
      'refactor-style changes, full schema authoring with context-aware reasoning. The MCP and',
      'the skills are complementary, not redundant.',
      '',
      '## 4. Workflow split',
      '',
      '- **Inspection / Q&A** (any MCP client: Claude Desktop, Cursor, Continue, Zed): use this MCP server',
      '- **Design / build / edit** (Claude Code, GitHub Copilot, Codex, Gemini CLI, Cursor): use the skills installed by the extension',
      '- **Visual editing**: use the canvas in VS Code',
      '',
      `Repo: ${EXTENSION_REPO_URL}`,
    ].join('\n');

    return {
      content: [{ type: 'text' as const, text }],
    };
  },
};
