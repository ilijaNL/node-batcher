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

export type BatcherConfig<T, R> = {
  /**
   * Function which called during flush
   * If an array is returned with id and data, it will try to resolve the promises with its data.
   * This is useful when doing querying
   */
  onFlush: (batch: Array<Item<T>>) => Promise<void | Array<{ id: string; data: R }>>;
  /**
   * Max targeted size
   */
  maxSize: number;
  /**
   * Max duration before the batch is flushed
   */
  maxTimeInMs: number;
  /**
   * Custom function to generate unique ids
   * Default is crypto.randomUUID
   */
  genId?(data: T): string;
};

/* @internal */
type _Item<T, R> = Item<T> & { at: number; resolve: (value: R | null) => void; reject: (reason?: any) => void };

export function createBatcher<T, R = void>(props: BatcherConfig<T, R>) {
  const { onFlush, maxSize, maxTimeInMs } = props;
  const _dataArray: Array<_Item<T, R>> = [];
  let timeout: NodeJS.Timeout | null = null;
  const genUuid = props.genId ?? (() => require('crypto').randomUUID());

  /**
   * Flushes the current batch (if any items)
   * @returns
   */
  async function flush(dataArray: Array<_Item<T, R>>): Promise<
    Array<{
      id: string;
      data: R;
    }>
  > {
    // already flushed somewhere else
    if (dataArray.length === 0) {
      return [];
    }

    const now = Date.now();

    const currentDataArray = dataArray.map<Item<T>>((d) => ({ data: d.data, delta_ms: now - d.at, id: d.id }));

    const result = await onFlush(currentDataArray).catch((e) => {
      // reject & rethrow
      dataArray.forEach((i) => i.reject(e));
      throw e;
    });

    if (Array.isArray(result)) {
      // map responses to the origin requests
      const map = new Map(result.map((obj) => [obj.id, obj.data]));
      dataArray.forEach((i) => i.resolve(map.get(i.id) ?? null));
    } else {
      // settle all promises
      dataArray.forEach((i) => i.resolve(null));
    }

    return result ?? [];
  }

  function _flush() {
    const prom = flush([..._dataArray]).catch(() => {});
    _dataArray.length = 0;
    return prom;
  }

  /**
   * Add an item to the current batch.
   * Resolves the promise when the batch is flushed
   * @param data
   */
  async function addAndWait(data: T): Promise<R | null> {
    const promise = new Promise<R | null>((resolve, reject) => {
      _dataArray.push({ data: data, delta_ms: 0, at: Date.now(), id: genUuid(data), reject, resolve });
    });

    if (_dataArray.length >= maxSize) {
      timeout && clearTimeout(timeout);
      _flush();
    }

    // first item, schedule a delay of maxTime and after flush
    if (_dataArray.length === 1) {
      // in background start flushing
      timeout = setTimeout(_flush, maxTimeInMs);
    }

    return promise;
  }

  return {
    add: addAndWait,
    async flush() {
      timeout && clearTimeout(timeout);
      return _flush();
    },
  };
}
