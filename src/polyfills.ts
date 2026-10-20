/**
 * Node 20 does not ship Promise.withResolvers (Node 22+ does), and the
 * OpenCode client's SSE reader relies on it. Install a spec-compatible
 * polyfill so the bridge runs on Node 20 as well.
 */
type WithResolvers = <T>() => {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

const target = Promise as unknown as { withResolvers?: WithResolvers }

if (typeof target.withResolvers !== "function") {
  target.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}
