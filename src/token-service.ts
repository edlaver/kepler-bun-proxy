interface TokenCacheEntry {
  token: string;
  lastUpdatedUnixMs: number;
}

class AsyncLock {
  private locked = false;
  private readonly queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }

    this.locked = false;
  }
}

export class TokenService {
  private readonly getTokenEndpoint: () => string;
  private readonly cache = new Map<string, TokenCacheEntry>();
  private readonly locks = new Map<string, AsyncLock>();

  constructor(getTokenEndpoint: () => string) {
    this.getTokenEndpoint = getTokenEndpoint;
  }

  async getToken(
    originalAuth: string,
    forceRefresh: boolean,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!forceRefresh) {
      const cached = this.cache.get(originalAuth);
      if (cached?.token) {
        return cached.token;
      }
    }

    const lock = this.getOrCreateLock(originalAuth);
    await lock.acquire();

    try {
      if (!forceRefresh) {
        const cached = this.cache.get(originalAuth);
        if (cached?.token) {
          return cached.token;
        }
      }

      const token = await this.requestToken(originalAuth, signal);
      if (!token) {
        return null;
      }

      this.cache.set(originalAuth, {
        token,
        lastUpdatedUnixMs: Date.now(),
      });
      return token;
    } finally {
      lock.release();
    }
  }

  private getOrCreateLock(key: string): AsyncLock {
    const existing = this.locks.get(key);
    if (existing) {
      return existing;
    }

    const lock = new AsyncLock();
    this.locks.set(key, lock);
    return lock;
  }

  private async requestToken(
    originalAuth: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const tokenEndpoint = this.getTokenEndpoint().trim();
    if (!tokenEndpoint) {
      return null;
    }

    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        authorization: originalAuth,
      },
      signal,
    });

    if (!response.ok) {
      return null;
    }

    const rawText = await response.text();
    if (!rawText.trim()) {
      return null;
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("json")) {
      try {
        const parsed = JSON.parse(rawText) as unknown;
        if (isObject(parsed)) {
          const token =
            readStringProperty(parsed, "token") ??
            readStringProperty(parsed, "access_token") ??
            readStringProperty(parsed, "accessToken");
          if (token) {
            return token;
          }
        }
      } catch {
        return rawText.trim();
      }
    }

    return rawText.trim();
  }
}

function readStringProperty(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const property = value[key];
  if (typeof property !== "string" || !property.trim()) {
    return null;
  }
  return property;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
