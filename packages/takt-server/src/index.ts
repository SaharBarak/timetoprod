import Fastify from 'fastify';
import cors from '@fastify/cors';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { registerRoutes } from './routes.js';
import { startModelRefreshLoop, getCurrentModel } from './model-engine.js';
import { getDb } from './db.js';
import { createMcpServer } from './mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Initialize database
  getDb();

  // Build initial model
  getCurrentModel();

  // Start periodic model refresh
  startModelRefreshLoop();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // CORS
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  // Register API routes
  await registerRoutes(app);

  // Serve SKILL.md
  const skillMdPath = path.join(__dirname, 'skill.md');
  // Try to read from src dir first, then dist dir
  let skillMdContent: string;
  try {
    skillMdContent = readFileSync(skillMdPath, 'utf-8');
  } catch {
    skillMdContent = readFileSync(path.join(__dirname, '..', 'src', 'skill.md'), 'utf-8');
  }

  app.get('/skill.md', async (request, reply) => {
    reply.type('text/markdown').send(skillMdContent);
  });

  // MCP endpoint
  const mcpServer = createMcpServer();

  app.post('/mcp', async (request, reply) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    reply.raw.on('close', () => {
      transport.close().catch(() => {});
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  app.get('/mcp', async (request, reply) => {
    reply.status(405).send({ error: 'Method not allowed. Use POST for MCP requests.' });
  });

  app.delete('/mcp', async (request, reply) => {
    reply.status(405).send({ error: 'Method not allowed.' });
  });

  // Start server
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';

  try {
    await app.listen({ port, host });
    console.log(`TAKT server running on http://${host}:${port}`);
    console.log(`MCP endpoint: http://${host}:${port}/mcp`);
    console.log(`SKILL.md: http://${host}:${port}/skill.md`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
