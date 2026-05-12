import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { list_domains } from './tools/list_domains.js';
import { read_domain } from './tools/read_domain.js';
import { list_models } from './tools/list_models.js';
import { read_model } from './tools/read_model.js';
import { list_manifest_models } from './tools/list_manifest_models.js';

const SERVER_INFO = {
  name: 'erd-studio-mcp',
  version: '0.1.0',
};

const INSTRUCTIONS = `ERD Studio MCP server — read-only access to a dbt project's semantic ERD model.

Every tool takes \`project_path\`: the absolute path to a dbt project root (the
directory containing dbt_project.yml). The project should also contain an
\`erd-studio/\` directory created by the ERD Studio VS Code extension.

Typical workflow:
1. list_domains — see what ERDs exist
2. read_domain — get models + relationships + cardinality for one ERD
3. read_model — get full column-level design for one logical model
4. list_manifest_models — see what dbt actually built (compare to design)`;

const tools = [
  list_domains,
  read_domain,
  list_models,
  read_model,
  list_manifest_models,
];

async function main(): Promise<void> {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  for (const tool of tools) {
    server.registerTool(tool.name, tool.config, async (args: unknown) => {
      try {
        return await tool.handler(args as never);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error in ${tool.name}: ${message}` }],
          isError: true,
        };
      }
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`erd-studio-mcp v${SERVER_INFO.version} listening on stdio`);
}

main().catch((err) => {
  console.error('Fatal error starting erd-studio-mcp:', err);
  process.exit(1);
});
