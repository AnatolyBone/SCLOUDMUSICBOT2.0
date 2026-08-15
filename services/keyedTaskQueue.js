export function createKeyedTaskQueue() {
  const tails = new Map();

  function run(key, task) {
    const previous = tails.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    const tail = current.catch(() => {});
    tails.set(key, tail);
    tail.finally(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return current;
  }

  return {
    run,
    has: key => tails.has(key),
    get size() {
      return tails.size;
    }
  };
}
