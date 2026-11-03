// Fetches `count` indexed pieces with limited concurrency and delivers them
// to `write` strictly in index order. Throws on abort or the first failure;
// by then every piece before the failed one that arrived has been written
// and no write is still running, so the output is a clean prefix and a
// later run can continue it from `start`.

export async function runPool({ count, start = 0, concurrency = 4, signal, fetchIndex, write }) {
  const results = new Array(count);
  let next = start;
  let writeIndex = start;
  let writeChain = Promise.resolve();
  let stopped = false;

  const flush = async () => {
    while (!stopped && writeIndex < count && results[writeIndex] !== undefined) {
      const data = results[writeIndex];
      results[writeIndex] = undefined;
      const index = writeIndex;
      writeIndex += 1;
      await write(index, data);
    }
  };

  const worker = async () => {
    while (!stopped && next < count) {
      if (signal?.aborted) throw signal.reason;
      const index = next++;
      results[index] = await fetchIndex(index);
      writeChain = writeChain.then(flush);
      await writeChain;
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, count - start) }, worker));
    await writeChain;
  } catch (error) {
    // Pieces still on their way are dropped; the write under way finishes.
    stopped = true;
    await writeChain.catch(() => {});
    throw error;
  }
}
