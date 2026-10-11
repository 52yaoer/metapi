import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const probeRuntimeModelMock = vi.fn();

vi.mock('./runtimeModelProbe.js', () => ({
  probeRuntimeModel: (...args: unknown[]) => probeRuntimeModelMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

describe('probeSiteModels account isolation', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let probeSiteModels: ModelServiceModule['probeSiteModels'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-probe-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    probeSiteModels = modelService.probeSiteModels;
  });

  beforeEach(async () => {
    probeRuntimeModelMock.mockReset();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.siteDisabledModels).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('probes each active account and keeps a rate-limited account from disabling the site model', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'multi-account-site',
      url: 'https://multi-account.example.com',
      platform: 'sub2api',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'account-a',
      accessToken: '',
      apiToken: 'sk-account-a',
      status: 'active',
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'account-b',
      accessToken: '',
      apiToken: 'sk-account-b',
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'gpt-6.1-sol', available: true },
      { accountId: accountB.id, modelName: 'gpt-6.1-sol', available: true },
    ]).run();

    let activeProbes = 0;
    let maxActiveProbes = 0;
    probeRuntimeModelMock.mockImplementation(async ({ account }: { account: { id: number } }) => {
      activeProbes += 1;
      maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeProbes -= 1;
      return account.id === accountA.id
        ? { status: 'inconclusive', latencyMs: 40, reason: 'HTTP 429: rate limited' }
        : { status: 'supported', latencyMs: 50, reason: 'probe succeeded' };
    });

    const result = await probeSiteModels(site.id, {
      scope: 'single',
      modelName: 'gpt-6.1-sol',
      concurrency: 2,
    });

    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(2);
    expect(maxActiveProbes).toBe(1);
    expect(probeRuntimeModelMock.mock.calls.map(([input]) => (input as { account: { id: number } }).account.id))
      .toEqual([accountA.id, accountB.id]);
    expect(result.unsupported).toBe(0);
    expect(result.details).toEqual([
      expect.objectContaining({ accountId: accountA.id, status: 'inconclusive' }),
      expect.objectContaining({ accountId: accountB.id, status: 'supported' }),
    ]);

    const availabilityRows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.modelName, 'gpt-6.1-sol'))
      .all();
    expect(availabilityRows).toHaveLength(2);
    expect(availabilityRows.every((row) => row.available)).toBe(true);

    const disabledRows = await db.select().from(schema.siteDisabledModels)
      .where(eq(schema.siteDisabledModels.siteId, site.id))
      .all();
    expect(disabledRows).toHaveLength(0);
  });

  it('marks only the account with a definite unsupported result unavailable', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'unsupported-account-site',
      url: 'https://unsupported-account.example.com',
      platform: 'sub2api',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'account-a',
      accessToken: '',
      apiToken: 'sk-account-a',
      status: 'active',
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'account-b',
      accessToken: '',
      apiToken: 'sk-account-b',
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'gpt-6.1-sol', available: true },
      { accountId: accountB.id, modelName: 'gpt-6.1-sol', available: true },
    ]).run();

    probeRuntimeModelMock.mockImplementation(async ({ account }: { account: { id: number } }) => (
      account.id === accountA.id
        ? { status: 'unsupported', latencyMs: 40, reason: 'model not found' }
        : { status: 'supported', latencyMs: 50, reason: 'probe succeeded' }
    ));

    const result = await probeSiteModels(site.id, { scope: 'single', modelName: 'gpt-6.1-sol' });

    expect(result.unsupported).toBe(1);
    expect(result.disabled).toBe(0);

    const availabilityRows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.modelName, 'gpt-6.1-sol'))
      .all();
    expect(availabilityRows.find((row) => row.accountId === accountA.id)?.available).toBe(false);
    expect(availabilityRows.find((row) => row.accountId === accountB.id)?.available).toBe(true);

    const disabledRows = await db.select().from(schema.siteDisabledModels)
      .where(eq(schema.siteDisabledModels.siteId, site.id))
      .all();
    expect(disabledRows).toHaveLength(0);
  });
});
