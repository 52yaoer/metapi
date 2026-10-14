import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fetchMock = vi.fn();
const selectPreferredChannelMock = vi.fn();
const recordFailureMock = vi.fn();

vi.mock('undici', async () => ({
  ...await vi.importActual<typeof import('undici')>('undici'),
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectPreferredChannel: (...args: unknown[]) => selectPreferredChannelMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
  },
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: vi.fn(),
  reportTokenExpired: vi.fn(),
}));

vi.mock('../../services/modelPricingService.js', () => ({ fetchModelPricingCatalog: vi.fn(async () => null) }));

type DbModule = typeof import('../../db/index.js');

describe('local API address rejection across proxy routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-local-endpoint-failure-'));
    await import('../../db/migrate.js');
    ({ db, schema } = await import('../../db/index.js'));
    app = Fastify();
    await app.register((await import('./chat.js')).chatProxyRoute);
    await app.register((await import('./chat.js')).claudeMessagesProxyRoute);
    await app.register((await import('./responses.js')).responsesProxyRoute);
    await app.register((await import('./completions.js')).completionsProxyRoute);
    await app.register((await import('./embeddings.js')).embeddingsProxyRoute);
    await app.register((await import('./images.js')).imagesProxyRoute);
    await app.register((await import('./search.js')).searchProxyRoute);
    await app.register((await import('./videos.js')).videosProxyRoute);
    await app.register((await import('./rerank.js')).rerankProxyRoute);
    await app.register((await import('./gemini.js')).geminiProxyRoute);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.delete(schema.accounts).run();
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.sites).run();
    const site = await db.insert(schema.sites).values({
      name: 'disabled-api-site', url: 'https://panel.example.com', platform: 'gemini', status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id, username: 'test-account', accessToken: '', status: 'active',
    }).returning().get();
    await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id, url: 'https://api.example.com', enabled: false,
    }).run();
    selectPreferredChannelMock.mockResolvedValue({
      channel: { id: 11, routeId: 22 }, site, account,
      tokenName: 'test-key', tokenValue: 'test-token', actualModel: 'test-model',
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    delete process.env.DATA_DIR;
  });

  it.each([
    ['/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] }],
    ['/v1/messages', { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }],
    ['/v1/responses', { model: 'test-model', input: 'hello' }],
    ['/v1/completions', { model: 'test-model', prompt: 'hello' }],
    ['/v1/embeddings', { model: 'test-model', input: 'hello' }],
    ['/v1/images/generations', { model: 'test-model', prompt: 'hello' }],
    ['/v1/search', { model: 'test-model', query: 'hello' }],
    ['/v1/videos', { model: 'test-model', prompt: 'hello' }],
    ['/v1/rerank', { model: 'test-model', query: 'hello', documents: ['world'] }],
    ['/v1beta/models/test-model:generateContent', { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }],
  ])('returns local 503 without channel penalties or upstream calls: %s', async (url, payload) => {
    const response = await app.inject({
      method: 'POST', url, payload,
      headers: { 'x-metapi-tester-request': '1', 'x-metapi-tester-forced-channel-id': '11' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({
      message: expect.stringContaining('已禁用'), type: 'server_error',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordFailureMock).not.toHaveBeenCalled();
  });
});
