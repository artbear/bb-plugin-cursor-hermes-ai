/** Unlike ACP's cooperative cancellation, this also bounds the caller's wait. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(signal.reason ?? new Error("Запрос отменён")); };
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
