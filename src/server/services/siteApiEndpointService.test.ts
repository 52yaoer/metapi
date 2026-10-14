import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { resetProxyChannelCoordinatorState } from './proxyChannelCoordinator.js';

type DbModule = typeof import('../db/index.js');
type SiteApiEndpointServiceModule = typeof import('./siteApiEndpointService.js');

describe('siteApiEndpointService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let selectSiteApiEndpointTarget: SiteApiEndpointServiceModule['selectSiteApiEndpointTarget'];
  let recordSiteApiEndpointFailure: SiteApiEndpointServiceModule['recordSiteApiEndpointFailure'];
  let recordSiteApiEndpointSuccess: SiteApiEndpointServiceModule['recordSiteApiEndpointSuccess'];
  let classifySiteApiEndpointFailure: SiteApiEndpointServiceModule['classifySiteApiEndpointFailure'];
  let runWithSiteApiEndpointPool: SiteApiEndpointServiceModule['runWithSiteApiEndpointPool'];
  let SiteApiEndpointRequestError: SiteApiEndpointServiceModule['SiteApiEndpointRequestError'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-api-endpoint-service-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const serviceModule = await import('./siteApiEndpointService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    selectSiteApiEndpointTarget = serviceModule.selectSiteApiEndpointTarget;
    recordSiteApiEndpointFailure = serviceModule.recordSiteApiEndpointFailure;
    recordSiteApiEndpointSuccess = serviceModule.recordSiteApiEndpointSuccess;
    classifySiteApiEndpointFailure = serviceModule.classifySiteApiEndpointFailure;
    runWithSiteApiEndpointPool = serviceModule.runWithSiteApiEndpointPool;
    SiteApiEndpointRequestError = serviceModule.SiteApiEndpointRequestError;
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T02:00:00.000Z'));
    resetProxyChannelCoordinatorState();
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.sites).run();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('does not rotate API addresses for upstream request validation errors', () => {
    const error = new SiteApiEndpointRequestError('No tool call found for tool output with call_id call_2.', {
      status: 400,
      upstreamResponse: true,
    });
    expect(classifySiteApiEndpointFailure({ status: 400, error })).toMatchObject({ retryable: false, rotateToNextEndpoint: false });
  });

  it.each(['siteConcurrencyTimeout', 'siteApiEndpointUnavailable'] as const)('does not rotate or cool endpoints for local %s failures', (flag) => {
    const error = new SiteApiEndpointRequestError('Site unavailable', { status: 503, [flag]: true });
    expect(classifySiteApiEndpointFailure({ status: 503, error })).toMatchObject({
      retryable: false, rotateToNextEndpoint: false,
    });
  });

  it('returns a synthetic site-url fallback when the site has no configured api endpoints', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'panel-only-site',
      url: 'https://panel.example.com/',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const selected = await selectSiteApiEndpointTarget(site, '2026-03-31T12:00:00.000Z');

    expect(selected).toMatchObject({
      kind: 'site-fallback',
      siteId: site.id,
      endpointId: null,
      baseUrl: 'https://panel.example.com',
      configuredEndpointCount: 0,
    });
  });

  it('does not rotate or cool down an endpoint for an upstream context limit failure', () => {
    const error = new SiteApiEndpointRequestError('The request exceeds the model context limit. Shorten the input and retry.', {
      status: 502,
      upstreamResponse: true,
    });
    expect(classifySiteApiEndpointFailure({ status: 502, error })).toMatchObject({
      retryable: false,
      rotateToNextEndpoint: false,
    });
  });

  it('selects the least recently selected enabled endpoint when sort order is tied', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'pool-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-b.example.com',
        enabled: true,
        sortOrder: 1,
        lastSelectedAt: '2026-03-31T11:59:00.000Z',
      },
      {
        siteId: site.id,
        url: 'https://api-a.example.com/',
        enabled: true,
        sortOrder: 0,
        lastSelectedAt: '2026-03-31T11:00:00.000Z',
      },
    ]).run();

    const selected = await selectSiteApiEndpointTarget(site, '2026-03-31T12:00:00.000Z');

    expect(selected).toMatchObject({
      kind: 'endpoint',
      siteId: site.id,
      baseUrl: 'https://api-a.example.com',
      configuredEndpointCount: 2,
      endpoint: expect.objectContaining({
        url: 'https://api-a.example.com/',
        sortOrder: 0,
      }),
    });
  });

  it('prefers lower sortOrder before lastSelectedAt when selecting an enabled endpoint', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ordered-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-secondary.example.com',
        enabled: true,
        sortOrder: 1,
        lastSelectedAt: '2026-03-31T11:00:00.000Z',
      },
      {
        siteId: site.id,
        url: 'https://api-primary.example.com',
        enabled: true,
        sortOrder: 0,
        lastSelectedAt: '2026-03-31T11:59:00.000Z',
      },
    ]).run();

    const selected = await selectSiteApiEndpointTarget(site, '2026-03-31T12:00:00.000Z');

    expect(selected).toMatchObject({
      kind: 'endpoint',
      siteId: site.id,
      baseUrl: 'https://api-primary.example.com',
      configuredEndpointCount: 2,
      endpoint: expect.objectContaining({
        url: 'https://api-primary.example.com',
        sortOrder: 0,
      }),
    });
  });

  it('skips disabled endpoints and endpoints that are still cooling down', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'filtered-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-disabled.example.com',
        enabled: false,
        sortOrder: 0,
      },
      {
        siteId: site.id,
        url: 'https://api-cooling.example.com',
        enabled: true,
        sortOrder: 1,
        cooldownUntil: '2026-03-31T12:05:00.000Z',
      },
      {
        siteId: site.id,
        url: 'https://api-ready.example.com',
        enabled: true,
        sortOrder: 2,
        cooldownUntil: '2026-03-31T11:55:00.000Z',
      },
    ]).run();

    const selected = await selectSiteApiEndpointTarget(site, '2026-03-31T12:00:00.000Z');

    expect(selected).toMatchObject({
      kind: 'endpoint',
      baseUrl: 'https://api-ready.example.com',
      configuredEndpointCount: 3,
    });
  });

  it('returns null when the site has configured api endpoints but none are currently eligible', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'exhausted-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-disabled.example.com',
        enabled: false,
        sortOrder: 0,
      },
      {
        siteId: site.id,
        url: 'https://api-cooling.example.com',
        enabled: true,
        sortOrder: 1,
        cooldownUntil: '2026-03-31T12:05:00.000Z',
      },
    ]).run();

    const selected = await selectSiteApiEndpointTarget(site, '2026-03-31T12:00:00.000Z');

    expect(selected).toBeNull();
  });

  it('records retryable failures with a 5-minute cooldown', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'retryable-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-retryable.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    const result = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 502,
      message: 'Bad gateway',
    }, '2026-03-31T12:00:00.000Z');

    expect(result).toMatchObject({
      retryable: true,
      rotateToNextEndpoint: true,
      cooldownUntil: '2026-03-31T12:05:00.000Z',
      failureReason: 'HTTP 502: Bad gateway',
    });

    const stored = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .get();
    expect(stored).toMatchObject({
      cooldownUntil: '2026-03-31T12:05:00.000Z',
      lastFailedAt: '2026-03-31T12:00:00.000Z',
      lastFailureReason: 'HTTP 502: Bad gateway',
    });
  });

  it('parses retryable HTTP status codes from failure messages when no explicit status is provided', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'message-status-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-message-status.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    const result = await recordSiteApiEndpointFailure(endpoint.id, {
      message: 'HTTP 502: upstream temporarily unavailable',
    }, '2026-03-31T12:00:00.000Z');

    expect(result).toMatchObject({
      retryable: true,
      rotateToNextEndpoint: true,
      cooldownUntil: '2026-03-31T12:05:00.000Z',
      failureReason: 'HTTP 502: upstream temporarily unavailable',
    });
  });

  it('records auth and validation failures without triggering cooldown rotation', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'non-retryable-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-auth.example.com',
      enabled: true,
      sortOrder: 0,
      cooldownUntil: '2026-03-31T11:00:00.000Z',
    }).returning().get();

    const result = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 401,
      message: 'Invalid token',
    }, '2026-03-31T12:00:00.000Z');

    expect(result).toMatchObject({
      retryable: false,
      rotateToNextEndpoint: false,
      cooldownUntil: null,
      failureReason: 'HTTP 401: Invalid token',
    });

    const stored = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .get();
    expect(stored).toMatchObject({
      cooldownUntil: null,
      lastFailedAt: '2026-03-31T12:00:00.000Z',
      lastFailureReason: 'HTTP 401: Invalid token',
    });
  });

  it.each([429, 500, 502, 503, 504, 520, 524])('does not cool a shared endpoint after an upstream HTTP %s response', async (status) => {
    const site = await db.insert(schema.sites).values({
      name: `shared-upstream-${status}-site`,
      url: 'https://panel.example.com',
      platform: 'sub2api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-shared.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    const upstreamFailure = new SiteApiEndpointRequestError(`HTTP ${status}: upstream response`, {
      status,
      upstreamResponse: true,
    });

    await expect(runWithSiteApiEndpointPool(site, async () => {
      throw upstreamFailure;
    })).rejects.toBe(upstreamFailure);

    const storedAfterFailure = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .get();
    expect(storedAfterFailure).toMatchObject({
      cooldownUntil: null,
      lastFailureReason: `HTTP ${status}: upstream response`,
    });

    const secondResult = await runWithSiteApiEndpointPool(site, async (target) => ({
      endpointId: target.endpointId,
    }));
    expect(secondResult).toEqual({ endpointId: endpoint.id });
  });

  it('does not probe cooling addresses for callers that have not enabled recovery', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'background-site', url: 'https://panel.example.com', platform: 'sub2api',
    }).returning().get();
    await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id, url: 'https://api.example.com', enabled: true,
      lastFailedAt: '2026-10-14T01:59:00.000Z', cooldownUntil: '2026-10-14T02:04:00.000Z',
    }).run();
    const operation = vi.fn(async () => 'unexpected');
    await expect(runWithSiteApiEndpointPool(site, operation)).rejects.toMatchObject({
      status: 503, siteApiEndpointUnavailable: true,
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not probe a cooling backup after trying a healthy address that returned 429', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'healthy-but-rate-limited-site', url: 'https://panel.example.com', platform: 'sub2api',
    }).returning().get();
    await db.insert(schema.siteApiEndpoints).values([
      { siteId: site.id, url: 'https://api-primary.example.com', enabled: true },
      { siteId: site.id, url: 'https://api-backup.example.com', enabled: true,
        lastFailedAt: '2026-10-14T01:59:00.000Z', cooldownUntil: '2026-10-14T02:04:00.000Z' },
    ]).run();
    const rateLimitError = new SiteApiEndpointRequestError('HTTP 429: rate limited', { status: 429, upstreamResponse: true });
    const operation = vi.fn(async (target: { baseUrl: string }) => {
      if (target.baseUrl.includes('primary')) throw rateLimitError;
      throw new TypeError('fetch failed');
    });
    await expect(runWithSiteApiEndpointPool(site, operation, { allowCooldownRecovery: true })).rejects.toBe(rateLimitError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('recovers a cooling endpoint before the full cooldown expires', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'recovering-site', url: 'https://panel.example.com', platform: 'sub2api',
    }).returning().get();
    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id, url: 'https://api.example.com', enabled: true,
      lastFailedAt: '2026-10-14T01:59:00.000Z',
      cooldownUntil: '2026-10-14T02:04:00.000Z',
      lastFailureReason: 'fetch failed',
    }).returning().get();

    expect(await selectSiteApiEndpointTarget(site)).toBeNull();
    const result = await runWithSiteApiEndpointPool(site, async (target) => target.endpointId, { allowCooldownRecovery: true });
    expect(result).toBe(endpoint.id);
    expect(await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id)).get()).toMatchObject({
      cooldownUntil: null, lastFailureReason: null,
      lastSelectedAt: '2026-10-14T02:00:00.000Z',
    });
  });

  it('allows only one recovery request per site while all addresses are cooling', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'single-recovery-site', url: 'https://panel.example.com', platform: 'sub2api',
    }).returning().get();
    await db.insert(schema.siteApiEndpoints).values([
      { siteId: site.id, url: 'https://api-a.example.com', enabled: true,
        lastFailedAt: '2026-10-14T01:59:00.000Z', cooldownUntil: '2026-10-14T02:04:00.000Z' },
      { siteId: site.id, url: 'https://api-b.example.com', enabled: true,
        lastFailedAt: '2026-10-14T01:59:10.000Z', cooldownUntil: '2026-10-14T02:04:10.000Z' },
    ]).run();
    let finishRecovery!: () => void;
    const recoveryResult = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const operation = vi.fn(async () => recoveryResult);
    const first = runWithSiteApiEndpointPool(site, operation, { allowCooldownRecovery: true });
    const second = runWithSiteApiEndpointPool(site, operation, { allowCooldownRecovery: true });
    const denied = expect(Promise.all([first, second])).rejects.toMatchObject({
      status: 503, message: expect.stringContaining('恢复请求进行中'),
    });
    try {
      await denied;
      expect(operation).toHaveBeenCalledTimes(1);
    } finally {
      finishRecovery();
      await Promise.allSettled([first, second]);
    }
    expect(await runWithSiteApiEndpointPool(site, async () => 'recovered')).toBe('recovered');
  });

  it('waits 30 seconds after a failed recovery before trying again', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'failed-recovery-site', url: 'https://panel.example.com', platform: 'sub2api',
    }).returning().get();
    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id, url: 'https://api.example.com', enabled: true,
      lastFailedAt: '2026-10-14T01:59:00.000Z', cooldownUntil: '2026-10-14T02:04:00.000Z',
    }).returning().get();
    const networkError = new TypeError('fetch failed');
    await expect(runWithSiteApiEndpointPool(site, async () => { throw networkError; }, { allowCooldownRecovery: true }))
      .rejects.toBe(networkError);
    const operation = vi.fn(async () => 'online');
    await expect(runWithSiteApiEndpointPool(site, operation, { allowCooldownRecovery: true })).rejects.toMatchObject({ status: 503 });
    vi.setSystemTime(new Date('2026-10-14T02:00:29.999Z'));
    await expect(runWithSiteApiEndpointPool(site, operation, { allowCooldownRecovery: true })).rejects.toMatchObject({ status: 503 });
    expect(operation).not.toHaveBeenCalled();
    expect(await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id)).get()).toMatchObject({
      lastFailedAt: '2026-10-14T02:00:00.000Z', cooldownUntil: '2026-10-14T02:05:00.000Z',
    });
    vi.setSystemTime(new Date('2026-10-14T02:00:30.000Z'));
    expect(await runWithSiteApiEndpointPool(site, operation, { allowCooldownRecovery: true })).toBe('online');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not recover disabled endpoints or recently failed endpoints', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'unavailable-site', url: 'https://panel.example.com', platform: 'sub2api',
    }).returning().get();
    await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id, url: 'https://api-disabled.example.com', enabled: false,
    }).run();
    const operation = vi.fn(async () => 'unexpected');
    await expect(runWithSiteApiEndpointPool(site, operation, { allowCooldownRecovery: true })).rejects.toMatchObject({
      status: 503, message: expect.stringContaining('已禁用'),
    });
    await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id, url: 'https://api-recent.example.com', enabled: true,
      lastFailedAt: '2026-10-14T01:59:50.000Z', cooldownUntil: '2026-10-14T02:04:50.000Z',
    }).run();
    await expect(runWithSiteApiEndpointPool(site, operation, { allowCooldownRecovery: true })).rejects.toMatchObject({
      status: 503, message: expect.stringContaining('冷却'),
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it('uses a healthy backup without probing a cooling primary', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'healthy-backup-site', url: 'https://panel.example.com', platform: 'sub2api',
    }).returning().get();
    await db.insert(schema.siteApiEndpoints).values([
      { siteId: site.id, url: 'https://api-primary.example.com', enabled: true, sortOrder: 0,
        lastFailedAt: '2026-10-14T01:59:00.000Z', cooldownUntil: '2026-10-14T02:04:00.000Z' },
      { siteId: site.id, url: 'https://api-backup.example.com', enabled: true, sortOrder: 1 },
    ]).run();
    expect(await runWithSiteApiEndpointPool(site, async (target) => target.baseUrl, { allowCooldownRecovery: true }))
      .toBe('https://api-backup.example.com');
  });

  it('tries each address once after an upstream 502 without cooling either address', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'upstream-backup-site', url: 'https://panel.example.com', platform: 'sub2api',
    }).returning().get();
    await db.insert(schema.siteApiEndpoints).values([
      { siteId: site.id, url: 'https://api-primary.example.com', enabled: true, sortOrder: 0 },
      { siteId: site.id, url: 'https://api-backup.example.com', enabled: true, sortOrder: 1 },
    ]).run();
    const attempted: string[] = [];
    const result = await runWithSiteApiEndpointPool(site, async (target) => {
      attempted.push(target.baseUrl);
      if (target.baseUrl.includes('primary')) {
        throw new SiteApiEndpointRequestError('Cloudflare 502: Bad gateway', {
          status: 502, upstreamResponse: true,
        });
      }
      return 'backup succeeded';
    });
    expect(result).toBe('backup succeeded');
    expect(attempted).toEqual(['https://api-primary.example.com', 'https://api-backup.example.com']);
    const endpoints = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.siteId, site.id)).all();
    expect(endpoints.every((endpoint) => endpoint.cooldownUntil === null)).toBe(true);
  });

  it('clears cooldown metadata and updates lastSelectedAt after a recorded success', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'success-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-success.example.com',
      enabled: true,
      sortOrder: 0,
      cooldownUntil: '2026-03-31T12:05:00.000Z',
      lastFailedAt: '2026-03-31T12:00:00.000Z',
      lastFailureReason: 'HTTP 502: Bad gateway',
    }).returning().get();

    await recordSiteApiEndpointSuccess(endpoint.id, '2026-03-31T12:01:00.000Z');

    const stored = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .orderBy(asc(schema.siteApiEndpoints.id))
      .get();
    expect(stored).toMatchObject({
      cooldownUntil: null,
      lastSelectedAt: '2026-03-31T12:01:00.000Z',
      lastFailureReason: null,
    });
  });

  it('holds the site lease until a streamed response is consumed', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'concurrency-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
      maxConcurrency: 1,
    }).returning().get();

    const first = await (await import('./siteApiEndpointService.js')).runWithSiteApiEndpointPool(
      site,
      async () => ({ upstream: new Response('first') }),
    );
    let secondSettled = false;
    const secondPromise = (await import('./siteApiEndpointService.js')).runWithSiteApiEndpointPool(
      site,
      async () => ({ upstream: new Response('second') }),
    ).then((result) => {
      secondSettled = true;
      return result;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondSettled).toBe(false);
    await (first as { upstream: Response }).upstream.text();
    const second = await secondPromise;
    expect(await (second as { upstream: Response }).upstream.text()).toBe('second');
  });

  it('releases the site lease when a streamed response is cancelled', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'cancelled-stream-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
      maxConcurrency: 1,
    }).returning().get();

    const first = await (await import('./siteApiEndpointService.js')).runWithSiteApiEndpointPool(
      site,
      async () => ({
        upstream: new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('first'));
          },
        })),
      }),
    );
    let secondSettled = false;
    const secondPromise = (await import('./siteApiEndpointService.js')).runWithSiteApiEndpointPool(
      site,
      async () => ({ upstream: new Response('second') }),
    ).then((result) => {
      secondSettled = true;
      return result;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondSettled).toBe(false);
    await (first as { upstream: Response }).upstream.body?.cancel('client disconnected');
    const second = await secondPromise;
    expect(await (second as { upstream: Response }).upstream.text()).toBe('second');
  });
});
