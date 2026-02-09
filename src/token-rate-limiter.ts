interface Bucket {
  capacity: number;
  available: number;
  refillRatePerSecond: number;
  lastRefillUnixMs: number;
  usageWindow: UsageSample[];
  usedInWindow: number;
}

interface UsageSample {
  atUnixMs: number;
  tokens: number;
}

export class TokenRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly activeKeys = new Set<string>();
  private lastStatusLength = 0;
  private lastStatusAtUnixMs = 0;
  private readonly statusIntervalMs = 250;
  private readonly statusTickMs = 1000;
  private statusTimer: ReturnType<typeof setInterval> | undefined;

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
    this.trackActiveKey(normalizedKey);

    while (true) {
      this.refillBucket(bucket);
      this.emitStatus(normalizedKey, bucket, false);
      if (bucket.available >= tokens) {
        bucket.available -= tokens;
        this.recordUsage(bucket, tokens);
        this.emitStatus(normalizedKey, bucket, true);
        return;
      }

      const deficit = tokens - bucket.available;
      const delaySeconds = deficit / bucket.refillRatePerSecond;
      const delayMs = Math.max(10, Math.ceil(delaySeconds * 1000));
      await sleep(delayMs, signal);
    }
  }

  registerLimit(key: string, limitPerMinute: number): void {
    if (limitPerMinute <= 0) {
      return;
    }

    const normalizedKey = key.toLowerCase();
    const bucket = this.getOrCreateBucket(normalizedKey, limitPerMinute);
    if (bucket.capacity !== limitPerMinute) {
      bucket.capacity = limitPerMinute;
      bucket.refillRatePerSecond = limitPerMinute / 60;
      bucket.available = Math.min(bucket.available, bucket.capacity);
    }

    this.trackActiveKey(normalizedKey);
    this.emitStatus(normalizedKey, bucket, true);
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
      usageWindow: [],
      usedInWindow: 0,
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

  private emitStatus(key: string, bucket: Bucket, force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastStatusAtUnixMs < this.statusIntervalMs) {
      return;
    }

    this.pruneUsageWindow(bucket, now);
    const used = Math.max(0, bucket.usedInWindow);
    const remaining = Math.max(0, bucket.capacity - used);
    const usedPercent = formatPercent(used, bucket.capacity);
    const remainingPercent = formatPercent(remaining, bucket.capacity);

    const message = `Rate limit ${key}: Used ${formatK(used)} / ${formatK(
      bucket.capacity,
    )} (${usedPercent}%) | Remaining ${formatK(remaining)} (${remainingPercent}%)`;

    if (process.stdout.isTTY) {
      const padded = message.padEnd(this.lastStatusLength, " ");
      process.stdout.write(`\r${padded}`);
      this.lastStatusLength = Math.max(this.lastStatusLength, message.length);
    } else {
      console.info(message);
    }

    this.lastStatusAtUnixMs = now;
  }

  private trackActiveKey(key: string): void {
    if (!this.activeKeys.has(key)) {
      this.activeKeys.add(key);
    }

    if (!this.statusTimer) {
      this.statusTimer = setInterval(() => {
        this.emitAllStatuses();
      }, this.statusTickMs);
    }
  }

  private emitAllStatuses(): void {
    for (const key of this.activeKeys) {
      const bucket = this.buckets.get(key);
      if (!bucket) {
        continue;
      }

      this.refillBucket(bucket);
      this.emitStatus(key, bucket, false);
    }
  }

  private recordUsage(bucket: Bucket, tokens: number): void {
    if (tokens <= 0) {
      return;
    }

    const now = Date.now();
    bucket.usageWindow.push({ atUnixMs: now, tokens });
    bucket.usedInWindow += tokens;
    this.pruneUsageWindow(bucket, now);
  }

  private pruneUsageWindow(bucket: Bucket, now: number): void {
    const cutoff = now - 60_000;
    while (bucket.usageWindow.length > 0) {
      const sample = bucket.usageWindow[0];
      if (sample.atUnixMs >= cutoff) {
        break;
      }
      bucket.usedInWindow -= sample.tokens;
      bucket.usageWindow.shift();
    }

    if (bucket.usedInWindow < 0) {
      bucket.usedInWindow = 0;
    }
  }
}

function formatK(value: number): string {
  const rounded = Math.max(0, Math.round(value));
  if (rounded < 1000) {
    return `${rounded}`;
  }

  const thousands = rounded / 1000;
  const display =
    thousands >= 100
      ? Math.round(thousands)
      : thousands >= 10
        ? Math.round(thousands * 10) / 10
        : Math.round(thousands * 100) / 100;

  return `${stripTrailingZeros(display)}k`;
}

function stripTrailingZeros(value: number): string {
  const text = value.toFixed(2);
  return text.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function formatPercent(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  const percent = (value / total) * 100;
  return Math.max(0, Math.min(100, Math.round(percent)));
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
