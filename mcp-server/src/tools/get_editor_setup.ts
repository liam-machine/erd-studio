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
      '## 2. Set up the semantic directory',
      '',
      'In VS Code, open Command Palette (`Cmd+Shift+P`) and run:',
      '',
      '```',
      'dbt: Set Up Semantic Domains Directory',
      '```',
      '',
      'This creates `erd-studio/` with `layers.json`, `logical-models/`, and `templates/`.',
      '',
      '## 3. Install the AI coding harness (writes the skill file)',
      '',
      'Command Palette → `dbt: Install AI Coding Harness`. Pick your assistant:',
      '',
      '| Assistant | File written |',
      '|---|---|',
      '| Claude Code | `.claude/skills/erd-studio/SKILL.md` (+ PreToolUse hook) |',
      '| GitHub Copilot | `.github/instructions/erd-studio.instructions.md` |',
      '| Google Gemini | `.gemini/styleguide.md` |',
      '| OpenAI Codex | `AGENTS.md` (appended) |',
      '',
      'For Claude Code users specifically, the skill provides deeper write integration than',
      'this MCP server — multi-file edits, refactor-style changes, full schema authoring with',
      'context-aware reasoning. The MCP and the skill are complementary, not redundant.',
      '',
      '## 4. Workflow split',
      '',
      '- **Inspection / Q&A** (any MCP client: Claude Desktop, Cursor, Continue, Zed): use this MCP server',
      '- **Design / build / edit** (Claude Code): use the skill installed by the extension',
      '- **Visual editing**: use the canvas in VS Code',
      '',
      `Repo: ${EXTENSION_REPO_URL}`,
    ].join('\n');

    return {
      content: [{ type: 'text' as const, text }],
    };
  },
};
