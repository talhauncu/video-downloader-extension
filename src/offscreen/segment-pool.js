// Fetches `count` indexed pieces with limited concurrency and delivers them
// to `write` strictly in index order. Throws on abort or the first failure.

export async function runPool({ count, concurrency = 4, signal, fetchIndex, write }) {
  const results = new Array(count);
  let next = 0;
  let writeIndex = 0;
  let writeChain = Promise.resolve();

  const flush = async () => {
    while (writeIndex < count && results[writeIndex] !== undefined) {
      const data = results[writeIndex];
      results[writeIndex] = undefined;
      const index = writeIndex;
      writeIndex += 1;
      await write(index, data);
    }
  };

  const worker = async () => {
    while (next < count) {
      if (signal?.aborted) throw signal.reason;
      const index = next++;
      results[index] = await fetchIndex(index);
      writeChain = writeChain.then(flush);
      await writeChain;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
  await writeChain;
}
