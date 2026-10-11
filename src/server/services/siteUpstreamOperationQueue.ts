type SiteUpstreamOperation<T> = {
  accountId: number;
  operation: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type SiteUpstreamQueue = {
  activeAccountId: number | null;
  activeCount: number;
  pending: Array<SiteUpstreamOperation<unknown>>;
};

const siteUpstreamQueues = new Map<number, SiteUpstreamQueue>();

function drainSiteUpstreamQueue(siteId: number): void {
  const queue = siteUpstreamQueues.get(siteId);
  if (!queue || queue.activeCount > 0) return;

  const next = queue.pending.shift();
  if (!next) {
    siteUpstreamQueues.delete(siteId);
    return;
  }

  queue.activeAccountId = next.accountId;
  queue.activeCount = 1;
  void executeSiteUpstreamOperation(siteId, next);
}

async function executeSiteUpstreamOperation<T>(siteId: number, item: SiteUpstreamOperation<T>): Promise<void> {
  try {
    item.resolve(await item.operation());
  } catch (error) {
    item.reject(error);
  } finally {
    const queue = siteUpstreamQueues.get(siteId);
    if (!queue) return;
    queue.activeCount -= 1;
    if (queue.activeCount === 0) {
      queue.activeAccountId = null;
      drainSiteUpstreamQueue(siteId);
    }
  }
}

export function runSerializedSiteUpstreamOperation<T>(
  siteId: number,
  accountId: number,
  operation: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let queue = siteUpstreamQueues.get(siteId);
    if (!queue) {
      queue = { activeAccountId: null, activeCount: 0, pending: [] };
      siteUpstreamQueues.set(siteId, queue);
    }

    const item: SiteUpstreamOperation<T> = { accountId, operation, resolve, reject };
    if (queue.activeCount === 0) {
      queue.activeAccountId = accountId;
      queue.activeCount = 1;
      void executeSiteUpstreamOperation(siteId, item);
      return;
    }
    if (queue.activeAccountId === accountId) {
      queue.activeCount += 1;
      void executeSiteUpstreamOperation(siteId, item);
      return;
    }
    queue.pending.push(item as SiteUpstreamOperation<unknown>);
  });
}
