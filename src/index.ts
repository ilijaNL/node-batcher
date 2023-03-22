export type Item<T> = {
  data: T;
  /**
   * unique identifier of the batch item. Can be used to map the batch result to calls
   */
  id: string;
  /**
   * Delta time in millisonds between adding item and handling the batch
   */
  delta_ms: number;
};

export type OnFlushFn<T, R> = (batch: Array<Item<T>>) => Promise<void | Array<{ id: string; data: R }>>;

export type BatcherConfig<T, R> = {
  /**
   * Function which called during flush
   * If an array is returned with id and data, it will try to resolve the promises with its data.
   * This is useful when doing querying
   */
  onFlush: OnFlushFn<T, R>;
  /**
   * Max targeted size
   */
  maxSize: number;
  /**
   * Max duration before the batch is flushed
   */
  maxTimeInMs: number;
  /**
   * Minimal time for a flush to happen after the first item is added
   */
  minTimeInMs?: number;
  /**
   * Custom function to generate unique ids
   * Defaults crypto.randomUUID
   */
  genId?(data: T): string;
};

/* @internal */
type _Item<T, R> = Item<T> & {
  at: number;
  resolve: (value: R | null) => void;
  reject: (reason?: any) => void;
  cancelled: boolean;
};

/**
 * Flushes the current batch (if any items)
 * @returns
 */
async function flush<T, R>(
  onFlush: OnFlushFn<T, R>,
  dataArray: Array<_Item<T, R>>
): Promise<
  Array<{
    id: string;
    data: R;
  }>
> {
  // remove all cancelled items from the flush, since they already are cancelled somehwere
  const _dataArray = dataArray.filter((i) => i.cancelled === false);

  if (_dataArray.length === 0) {
    return [];
  }

  const now = Date.now();

  const currentDataArray = _dataArray.map<Item<T>>((d) => ({ data: d.data, delta_ms: now - d.at, id: d.id }));

  const result = await onFlush(currentDataArray).catch((e) => {
    // reject & rethrow
    _dataArray.forEach((i) => i.reject(e));
    throw e;
  });

  if (Array.isArray(result)) {
    // map responses to the origin requests
    const map = new Map(result.map((obj) => [obj.id, obj.data]));
    _dataArray.forEach((i) => i.resolve(map.get(i.id) ?? null));
  } else {
    // settle all promises
    _dataArray.forEach((i) => i.resolve(null));
  }

  return result ?? [];
}

const createRandomUuidFn = <T>() => {
  const crypto = require('crypto');

  return (_: T) => crypto.randomUUID();
};

export function createBatcher<T, R = void>(props: BatcherConfig<T, R>) {
  const { onFlush, maxSize, maxTimeInMs, minTimeInMs } = props;
  const _dataArray: Array<_Item<T, R>> = [];
  let batchTimeout: NodeJS.Timeout | null = null;
  const genUuid = props.genId ?? createRandomUuidFn<T>();

  const pendingFlushes: Array<{
    settle: (() => ReturnType<typeof flush>) | null;
    promise: Promise<any>;
  }> = [];

  function _flush() {
    /* istanbul ignore next */
    if (_dataArray.length === 0) {
      return Promise.resolve([]);
    }
    const itemsToFlush = [..._dataArray];
    _dataArray.length = 0;

    let settle: (() => void) | null = null;

    const timePending = Date.now() - itemsToFlush[0]!.at;
    const timeToFlush = Math.max((minTimeInMs ?? 0) - timePending, 0);
    const prom =
      timeToFlush > 0
        ? new Promise<void>((resolve) => {
            let isSettled = false;
            settle = () => {
              /* istanbul ignore next */
              if (isSettled) {
                return;
              }

              isSettled = true;
              clearTimeout(timeoutId);
              resolve();
            };
            const timeoutId = setTimeout(settle, timeToFlush);
          }).then(() => flush(onFlush, itemsToFlush))
        : flush(onFlush, itemsToFlush);

    const flushItem = {
      promise: prom,
      settle,
    };

    pendingFlushes.push(flushItem);

    // catch and remove when complete
    prom
      .catch(() => {})
      .finally(() => {
        pendingFlushes.filter((p) => p !== flushItem);
      });

    return prom;
  }

  /**
   * Add an item to the current batch.
   * Resolves the promise when the batch is flushed or is cancelled
   * @param data
   */
  function addAndWait(data: T): Promise<R | null> & { cancel: (value: R | null) => void } {
    let cancel!: (value: R | null) => void;
    const promise = new Promise<R | null>((resolve, reject) => {
      const item = { data: data, delta_ms: 0, at: Date.now(), id: genUuid(data), reject, resolve, cancelled: false };
      cancel = (value: R | null) => {
        if (item.cancelled) {
          return;
        }
        item.cancelled = true;
        resolve(value);
      };
      _dataArray.push(item);
    });

    if (_dataArray.length >= maxSize) {
      batchTimeout && clearTimeout(batchTimeout);
      _flush();
    }

    // first item, schedule a delay of maxTime and after flush
    if (_dataArray.length === 1) {
      // in background start flushing
      batchTimeout = setTimeout(_flush, maxTimeInMs);
    }

    return Object.assign(promise, { cancel });
  }

  return {
    add: addAndWait,
    /**
     * Immediatly flushes all the batches and waits for all flushes to complete
     * This function is useful when shutting down the service
     */
    async waitForAll() {
      // clear the latest flush
      batchTimeout && clearTimeout(batchTimeout);
      _flush();

      pendingFlushes.forEach((f) => {
        f.settle?.();
      });

      // wait for all promises to complete
      await Promise.all(pendingFlushes.map((f) => f.promise));
    },
  };
}
