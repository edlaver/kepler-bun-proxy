interface Bucket {
  capacity: number;
  available: number;
  refillRatePerSecond: number;
  lastRefillUnixMs: number;
}

export class TokenRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  async waitForTokens(
    key: string,
    limitPerMinute: number,
    tokens: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (limitPerMinute <= 0 || tokens <= 0) {
      return;
    }

    if (tokens > limitPerMinute) {
      return;
    }

    const normalizedKey = key.toLowerCase();
    const bucket = this.getOrCreateBucket(normalizedKey, limitPerMinute);

    while (true) {
      this.refillBucket(bucket);
      if (bucket.available >= tokens) {
        bucket.available -= tokens;
        return;
      }

      const deficit = tokens - bucket.available;
      const delaySeconds = deficit / bucket.refillRatePerSecond;
      const delayMs = Math.max(10, Math.ceil(delaySeconds * 1000));
      await sleep(delayMs, signal);
    }
  }

  private getOrCreateBucket(key: string, limitPerMinute: number): Bucket {
    const existing = this.buckets.get(key);
    if (existing) {
      return existing;
    }

    const bucket: Bucket = {
      capacity: limitPerMinute,
      available: limitPerMinute,
      refillRatePerSecond: limitPerMinute / 60,
      lastRefillUnixMs: Date.now(),
    };
    this.buckets.set(key, bucket);
    return bucket;
  }

  private refillBucket(bucket: Bucket): void {
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefillUnixMs;
    if (elapsedMs <= 0) {
      return;
    }

    bucket.available = Math.min(
      bucket.capacity,
      bucket.available + (elapsedMs / 1000) * bucket.refillRatePerSecond,
    );
    bucket.lastRefillUnixMs = now;
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
    return;
  }

  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
