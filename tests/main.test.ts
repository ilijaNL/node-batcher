import delay from 'delay';
import tap from 'tap';
import { createBatcher } from '../src';

tap.jobs = 10;

tap.test('executes as batch', async (t) => {
  t.plan(2);
  let first = true;
  const batcher = createBatcher<number>({
    async onFlush(batch) {
      if (first) {
        first = false;
        t.same(
          batch.map((d) => d.data),
          [1, 2, 4]
        );
      } else {
        t.same(
          batch.map((d) => d.data),
          [8]
        );
      }
    },
    maxSize: 3,
    maxTimeInMs: 100,
  });

  batcher.add(1);
  batcher.add(2);
  batcher.add(4);
  batcher.add(8);

  await delay(120);
});

tap.test('every add rejects', async (t) => {
  t.plan(3);
  const err = new Error('throws');
  const batcher = createBatcher<number>({
    async onFlush() {
      throw err;
    },
    maxSize: 5,
    maxTimeInMs: 100,
  });

  t.rejects(batcher.add(1), err);
  t.rejects(batcher.add(2), err);
  t.rejects(batcher.add(4), err);

  await delay(150);
});

tap.test('maps the response to corresponding data', async (t) => {
  t.plan(3);
  const batcher = createBatcher<number, number>({
    async onFlush(batch) {
      return batch.map((i) => ({
        id: i.id,
        data: i.data,
      }));
    },
    maxSize: 5,
    maxTimeInMs: 100,
  });

  t.resolveMatch(batcher.add(2), 2);
  t.resolveMatch(batcher.add(1), 1);
  t.resolveMatch(batcher.add(4), 4);

  await delay(150);
});

tap.test('max size', async (t) => {
  t.plan(24);
  const batcher = createBatcher<number, number>({
    async onFlush(batch) {
      t.equal(batch.length, 5);

      return batch.map((b) => ({ id: b.id, data: b.data }));
    },
    maxSize: 5,
    maxTimeInMs: 500,
  });

  for (let i = 0; i < 20; i++) {
    t.resolveMatch(batcher.add(i).catch(), i);
  }

  await delay(150);
});

tap.test('max duration', async (t) => {
  t.plan(3);
  let called = 0;

  const batcher = createBatcher<number, number>({
    async onFlush(batch) {
      called += 1;
      t.equal(batch.length, 3);
    },
    maxSize: 10,
    maxTimeInMs: 100,
  });

  batcher.add(1);
  batcher.add(3);
  batcher.add(4);
  await delay(10);
  t.equal(called, 0);
  await delay(100);
  t.equal(called, 1);
});

tap.test('gen id', async (t) => {
  const batcher = createBatcher<number, number>({
    genId(data) {
      return String(data);
    },
    async onFlush(data) {
      data.forEach((d) => {
        t.equal(d.id, String(d.data));
      });
    },
    maxSize: 10,
    maxTimeInMs: 50,
  });

  batcher.add(1);
  batcher.add(5);

  await delay(50);
});

tap.test('flushes', async (t) => {
  t.plan(5);
  const batcher = createBatcher<number, number>({
    genId(data) {
      return String(data);
    },
    async onFlush(data) {
      t.same(
        data.map((d) => d.data),
        [1, 5]
      );

      return data.map((d) => ({ id: d.id, data: d.data + 1 }));
    },
    maxSize: 10,
    maxTimeInMs: 2000,
  });

  t.resolveMatch(batcher.add(1), 2);
  t.resolveMatch(batcher.add(5), 6);

  const res1 = await batcher.flush();
  t.same(res1, [
    { id: '1', data: 2 },
    { id: '5', data: 6 },
  ]);

  const res2 = await batcher.flush();
  t.same(res2, []);
});

tap.test('long flush', async (t) => {
  let state = { first: true };
  const batcher = createBatcher<number, number>({
    async onFlush(data) {
      if (state.first) {
        state.first = false;
        await delay(100);
      }

      return data.map((d) => ({ id: d.id, data: d.data + 1 }));
    },
    maxSize: 3,
    maxTimeInMs: 50,
  });

  const result: number[] = [];

  batcher.add(1).then((r) => result.push(r!));
  batcher.add(4).then((r) => result.push(r!));
  batcher.add(8).then((r) => result.push(r!));
  batcher.add(20).then((r) => result.push(r!));

  await delay(200);

  t.same(result, [21, 2, 5, 9]);
});
