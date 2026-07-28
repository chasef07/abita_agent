export function deferredResult<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((value) => {
    resolve = value;
  });
  return { promise, resolve };
}
