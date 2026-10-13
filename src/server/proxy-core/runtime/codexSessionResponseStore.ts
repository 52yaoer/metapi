import { config } from '../../config.js';

const MAX_CODEX_SESSION_RESPONSE_IDS = 10_000;
const MIN_CODEX_SESSION_RESPONSE_TTL_MS = 5 * 60 * 1000;

type SessionResponseEntry = {
  responseId: string;
  updatedAtMs: number;
};

const codexSessionResponseIds = new Map<string, SessionResponseEntry>();

const SCOPED_SESSION_SEGMENT_PREFIX = 'session:';
const SITE_SCOPE_SEGMENT_PATTERN = /^site:\d+$/;
const MODEL_SCOPE_SEGMENT_PATTERN = /^model:.+$/;
const DRIFT_SCOPE_SEGMENT_PATTERN = /^(?:account|channel):\d+$/;

function buildScopedSessionSegment(sessionId: string): string {
  return `${SCOPED_SESSION_SEGMENT_PREFIX}${encodeURIComponent(sessionId)}`;
}

function buildScopedModelSegment(model: string): string {
  return `model:${encodeURIComponent(model)}`;
}

type ParsedScopedSessionKey = {
  scopeSegments: string[];
  sessionSegment: string;
};

// A scoped store key looks like `site:<id>|model:<model>|account:<id>|channel:<id>|session:<id>`.
// The scope reduces to the site and upstream model that actually own the upstream response id, so a
// remembered continuation id is never reused across a different upstream identity.
function parseScopedSessionKey(sessionId: string): ParsedScopedSessionKey | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return null;
  if (normalizedSessionId.startsWith(SCOPED_SESSION_SEGMENT_PREFIX)) return null;

  const segments = normalizedSessionId
    .split('|')
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length <= 1) return null;

  const sessionSegment = segments[segments.length - 1];
  if (!sessionSegment.startsWith(SCOPED_SESSION_SEGMENT_PREFIX)) return null;

  const scopeSegments: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (SITE_SCOPE_SEGMENT_PATTERN.test(segment) || MODEL_SCOPE_SEGMENT_PATTERN.test(segment)) {
      scopeSegments.push(segment);
      continue;
    }
    if (DRIFT_SCOPE_SEGMENT_PATTERN.test(segment)) continue;
    return null;
  }

  return { scopeSegments, sessionSegment };
}

function buildScopeSessionStoreKey(sessionId: string): string {
  const parsed = parseScopedSessionKey(sessionId);
  if (!parsed) return '';
  return [...parsed.scopeSegments, parsed.sessionSegment].join('|');
}

function getFallbackSessionStoreKeys(sessionId: string): string[] {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return [];

  const scopeSessionKey = buildScopeSessionStoreKey(normalizedSessionId);
  if (!scopeSessionKey) return [];
  if (normalizedSessionId === scopeSessionKey) return [];
  return [scopeSessionKey];
}

function getSessionStoreKeys(sessionId: string): string[] {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return [];
  return [
    normalizedSessionId,
    ...getFallbackSessionStoreKeys(normalizedSessionId),
  ];
}

function reconcileScopedSessionFallback(scopeSessionKey: string): void {
  if (!scopeSessionKey) return;

  for (const key of codexSessionResponseIds.keys()) {
    if (key === scopeSessionKey) continue;
    if (buildScopeSessionStoreKey(key) !== scopeSessionKey) continue;
    codexSessionResponseIds.delete(key);
  }
}

function normalizeSessionId(sessionId: string): string {
  return sessionId.trim();
}

function getCodexSessionResponseTtlMs(): number {
  return Math.max(
    MIN_CODEX_SESSION_RESPONSE_TTL_MS,
    Math.trunc(config.proxyStickySessionTtlMs || 0),
  );
}

function isExpiredSessionResponseEntry(entry: SessionResponseEntry, nowMs = Date.now()): boolean {
  return (entry.updatedAtMs + getCodexSessionResponseTtlMs()) <= nowMs;
}

function sweepExpiredSessionResponseIds(nowMs = Date.now()): void {
  for (const [key, entry] of codexSessionResponseIds.entries()) {
    if (!isExpiredSessionResponseEntry(entry, nowMs)) continue;
    codexSessionResponseIds.delete(key);
  }
}

function touchSessionResponseEntry(sessionId: string, nowMs = Date.now()): void {
  for (const key of getSessionStoreKeys(sessionId)) {
    const entry = codexSessionResponseIds.get(key);
    if (!entry) continue;
    entry.updatedAtMs = nowMs;
    codexSessionResponseIds.set(key, entry);
  }
}

export function buildCodexSessionResponseStoreKey(input: {
  sessionId: string;
  siteId?: number | null;
  model?: string | null;
  accountId?: number | null;
  channelId?: number | null;
}): string {
  const normalizedSessionId = normalizeSessionId(input.sessionId);
  if (!normalizedSessionId) return '';
  const normalizedModel = typeof input.model === 'string' ? input.model.trim() : '';
  const parts = [
    Number.isFinite(input.siteId as number) && Number(input.siteId) > 0 ? `site:${Math.trunc(Number(input.siteId))}` : '',
    normalizedModel ? buildScopedModelSegment(normalizedModel) : '',
    Number.isFinite(input.accountId as number) && Number(input.accountId) > 0 ? `account:${Math.trunc(Number(input.accountId))}` : '',
    Number.isFinite(input.channelId as number) && Number(input.channelId) > 0 ? `channel:${Math.trunc(Number(input.channelId))}` : '',
    buildScopedSessionSegment(normalizedSessionId),
  ].filter(Boolean);
  return parts.join('|');
}

export function getCodexSessionResponseId(sessionId: string): string | null {
  const nowMs = Date.now();
  sweepExpiredSessionResponseIds(nowMs);
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return null;

  const direct = codexSessionResponseIds.get(normalized);
  if (direct) {
    touchSessionResponseEntry(normalized, nowMs);
    return direct.responseId;
  }

  for (const fallbackKey of getFallbackSessionStoreKeys(normalized)) {
    const fallback = codexSessionResponseIds.get(fallbackKey);
    if (fallback) {
      reconcileScopedSessionFallback(fallbackKey);
      touchSessionResponseEntry(fallbackKey, nowMs);
      return fallback.responseId;
    }
  }

  return null;
}

export function setCodexSessionResponseId(sessionId: string, responseId: string): void {
  const nowMs = Date.now();
  sweepExpiredSessionResponseIds(nowMs);
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedResponseId = responseId.trim();
  if (!normalizedSessionId || !normalizedResponseId) return;

  const keysToWrite = new Set<string>(getSessionStoreKeys(normalizedSessionId));

  for (const key of keysToWrite) {
    if (codexSessionResponseIds.has(key)) {
      codexSessionResponseIds.delete(key);
    }
    codexSessionResponseIds.set(key, {
      responseId: normalizedResponseId,
      updatedAtMs: nowMs,
    });
  }

  while (codexSessionResponseIds.size > MAX_CODEX_SESSION_RESPONSE_IDS) {
    const oldestKey = codexSessionResponseIds.keys().next().value;
    if (!oldestKey) break;
    codexSessionResponseIds.delete(oldestKey);
  }
}

export function clearCodexSessionResponseId(sessionId: string): void {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return;
  for (const key of getSessionStoreKeys(normalized)) {
    codexSessionResponseIds.delete(key);
  }
}

export function resetCodexSessionResponseStore(): void {
  codexSessionResponseIds.clear();
}
