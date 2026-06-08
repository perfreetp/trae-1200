import { CacheEntry, TraceQueryResult } from '../types';
import { getStorageAdapter } from '../utils';

const DEFAULT_CACHE_TTL = 3600000;
const DEFAULT_MAX_SIZE = 100;
const STORAGE_PREFIX = 'drug_trace_cache_';
const STORAGE_KEYS = `${STORAGE_PREFIX}keys`;

export interface CacheStats {
  totalEntries: number;
  expiredEntries: number;
  hitCount: number;
  missCount: number;
  evictCount: number;
}

export type CacheCategory = 'query' | 'batch' | 'flow' | 'recall' | 'drug';

export class CacheManager {
  private memoryCache: Map<string, CacheEntry<unknown>> = new Map();
  private storage: ReturnType<typeof getStorageAdapter>;
  private ttl: number;
  private maxSize: number;
  private hitCount = 0;
  private missCount = 0;
  private evictCount = 0;
  private cleanTimer: ReturnType<typeof setInterval> | null = null;
  private enablePersistence: boolean;

  constructor(options?: {
    ttl?: number;
    maxSize?: number;
    enablePersistence?: boolean;
    autoClean?: boolean;
    cleanInterval?: number;
  }) {
    this.ttl = options?.ttl ?? DEFAULT_CACHE_TTL;
    this.maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
    this.enablePersistence = options?.enablePersistence ?? true;
    this.storage = getStorageAdapter();

    if (this.enablePersistence) {
      this.loadFromStorage();
    }

    if (options?.autoClean) {
      this.startAutoClean(options.cleanInterval ?? 300000);
    }
  }

  set(key: string, value: unknown, ttl?: number, category?: CacheCategory): boolean {
    try {
      const cacheKey = this.buildKey(key, category);
      const now = Date.now();
      const expireTime = now + (ttl ?? this.ttl);

      if (this.memoryCache.size >= this.maxSize && !this.memoryCache.has(cacheKey)) {
        this.evictOldest();
      }

      const entry: CacheEntry<unknown> = {
        key: cacheKey,
        value,
        createTime: now,
        expireTime,
        accessCount: 0
      };

      this.memoryCache.set(cacheKey, entry);

      if (this.enablePersistence) {
        this.persistEntry(cacheKey, entry);
      }

      return true;
    } catch {
      return false;
    }
  }

  get<T>(key: string, category?: CacheCategory): T | null {
    const cacheKey = this.buildKey(key, category);
    const entry = this.memoryCache.get(cacheKey);

    if (!entry) {
      if (this.enablePersistence) {
        const storedEntry = this.loadEntry<T>(cacheKey);
        if (storedEntry) {
          this.memoryCache.set(cacheKey, storedEntry);
          return this.checkAndReturnEntry<T>(storedEntry, cacheKey);
        }
      }
      this.missCount++;
      return null;
    }

    return this.checkAndReturnEntry<T>(entry, cacheKey);
  }

  getOrSet<T>(
    key: string,
    fn: () => T | Promise<T>,
    ttl?: number,
    category?: CacheCategory
  ): Promise<T> | T {
    const cached = this.get<T>(key, category);
    if (cached !== null) {
      return cached;
    }

    const result = fn();

    if (result instanceof Promise) {
      return result.then(value => {
        this.set(key, value, ttl, category);
        return value;
      });
    }

    this.set(key, result, ttl, category);
    return result;
  }

  has(key: string, category?: CacheCategory): boolean {
    const cacheKey = this.buildKey(key, category);
    const entry = this.memoryCache.get(cacheKey);

    if (entry) {
      return !this.isExpired(entry);
    }

    if (this.enablePersistence) {
      const storedEntry = this.loadEntry<unknown>(cacheKey);
      if (storedEntry && !this.isExpired(storedEntry)) {
        this.memoryCache.set(cacheKey, storedEntry);
        return true;
      }
    }

    return false;
  }

  delete(key: string, category?: CacheCategory): boolean {
    const cacheKey = this.buildKey(key, category);
    const deleted = this.memoryCache.delete(cacheKey);

    if (this.enablePersistence) {
      this.storage.removeItem(cacheKey);
      this.persistKeys();
    }

    return deleted;
  }

  clear(category?: CacheCategory): number {
    let clearedCount = 0;

    if (category) {
      const prefix = `${STORAGE_PREFIX}${category}_`;
      for (const key of this.memoryCache.keys()) {
        if (key.startsWith(prefix)) {
          this.memoryCache.delete(key);
          clearedCount++;
          if (this.enablePersistence) {
            this.storage.removeItem(key);
          }
        }
      }
    } else {
      clearedCount = this.memoryCache.size;
      this.memoryCache.clear();
      if (this.enablePersistence) {
        const keysStr = this.storage.getItem(STORAGE_KEYS);
        if (keysStr) {
          const keys: string[] = JSON.parse(keysStr);
          keys.forEach(k => this.storage.removeItem(k));
        }
      }
    }

    if (this.enablePersistence) {
      this.persistKeys();
    }

    return clearedCount;
  }

  cleanExpired(): number {
    const expiredKeys: string[] = [];
    const now = Date.now();

    for (const [key, entry] of this.memoryCache) {
      if (entry.expireTime <= now) {
        expiredKeys.push(key);
      }
    }

    expiredKeys.forEach(key => {
      this.memoryCache.delete(key);
      if (this.enablePersistence) {
        this.storage.removeItem(key);
      }
    });

    const expiredFromStorage = this.cleanStorageExpired();

    if (this.enablePersistence) {
      this.persistKeys();
    }

    this.evictCount += expiredKeys.length + expiredFromStorage;
    return expiredKeys.length + expiredFromStorage;
  }

  getStats(): CacheStats {
    let expiredEntries = 0;
    const now = Date.now();

    for (const entry of this.memoryCache.values()) {
      if (entry.expireTime <= now) {
        expiredEntries++;
      }
    }

    return {
      totalEntries: this.memoryCache.size,
      expiredEntries,
      hitCount: this.hitCount,
      missCount: this.missCount,
      evictCount: this.evictCount
    };
  }

  resetStats(): void {
    this.hitCount = 0;
    this.missCount = 0;
    this.evictCount = 0;
  }

  getAllKeys(category?: CacheCategory): string[] {
    const prefix = category ? `${STORAGE_PREFIX}${category}_` : STORAGE_PREFIX;
    const keys: string[] = [];

    for (const key of this.memoryCache.keys()) {
      if (key.startsWith(prefix)) {
        keys.push(key.substring(STORAGE_PREFIX.length));
      }
    }

    return keys;
  }

  setQueryResult(code: string, result: TraceQueryResult, ttl?: number): boolean {
    return this.set(`query_${code}`, result, ttl, 'query');
  }

  getQueryResult(code: string): TraceQueryResult | null {
    return this.get<TraceQueryResult>(`query_${code}`, 'query');
  }

  startAutoClean(interval: number = 300000): void {
    this.stopAutoClean();
    this.cleanTimer = setInterval(() => {
      this.cleanExpired();
    }, interval);
  }

  stopAutoClean(): void {
    if (this.cleanTimer) {
      clearInterval(this.cleanTimer);
      this.cleanTimer = null;
    }
  }

  getEntryInfo(key: string, category?: CacheCategory): {
    exists: boolean;
    isExpired: boolean;
    remainingTTL: number;
    accessCount: number;
    createTime: number;
  } | null {
    const cacheKey = this.buildKey(key, category);
    const entry = this.memoryCache.get(cacheKey);

    if (!entry) {
      return null;
    }

    const now = Date.now();
    const isExpired = entry.expireTime <= now;

    return {
      exists: true,
      isExpired,
      remainingTTL: isExpired ? 0 : entry.expireTime - now,
      accessCount: entry.accessCount,
      createTime: entry.createTime
    };
  }

  private buildKey(key: string, category?: CacheCategory): string {
    if (category) {
      return `${STORAGE_PREFIX}${category}_${key}`;
    }
    return `${STORAGE_PREFIX}${key}`;
  }

  private isExpired(entry: CacheEntry<unknown>): boolean {
    return entry.expireTime <= Date.now();
  }

  private checkAndReturnEntry<T>(entry: CacheEntry<unknown>, cacheKey: string): T | null {
    if (this.isExpired(entry)) {
      this.memoryCache.delete(cacheKey);
      if (this.enablePersistence) {
        this.storage.removeItem(cacheKey);
        this.persistKeys();
      }
      this.evictCount++;
      this.missCount++;
      return null;
    }

    entry.accessCount++;
    this.hitCount++;
    return entry.value as T;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestCreateTime = Infinity;

    for (const [key, entry] of this.memoryCache) {
      if (entry.createTime < oldestCreateTime) {
        oldestCreateTime = entry.createTime;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.memoryCache.delete(oldestKey);
      if (this.enablePersistence) {
        this.storage.removeItem(oldestKey);
        this.persistKeys();
      }
      this.evictCount++;
    }
  }

  private persistEntry(cacheKey: string, entry: CacheEntry<unknown>): void {
    try {
      this.storage.setItem(cacheKey, JSON.stringify(entry));
      this.persistKeys();
    } catch {
      // ignore persistence errors
    }
  }

  private loadEntry<T>(cacheKey: string): CacheEntry<T> | null {
    try {
      const data = this.storage.getItem(cacheKey);
      if (!data) return null;
      return JSON.parse(data) as CacheEntry<T>;
    } catch {
      return null;
    }
  }

  private persistKeys(): void {
    try {
      const keys = Array.from(this.memoryCache.keys());
      this.storage.setItem(STORAGE_KEYS, JSON.stringify(keys));
    } catch {
      // ignore
    }
  }

  private loadFromStorage(): void {
    try {
      const keysStr = this.storage.getItem(STORAGE_KEYS);
      if (!keysStr) return;

      const keys: string[] = JSON.parse(keysStr);
      const now = Date.now();

      for (const key of keys) {
        const entry = this.loadEntry<unknown>(key);
        if (entry && entry.expireTime > now) {
          this.memoryCache.set(key, entry);
        } else if (entry) {
          this.storage.removeItem(key);
        }
      }

      this.persistKeys();
    } catch {
      // ignore
    }
  }

  private cleanStorageExpired(): number {
    let count = 0;
    try {
      const keysStr = this.storage.getItem(STORAGE_KEYS);
      if (!keysStr) return 0;

      const keys: string[] = JSON.parse(keysStr);
      const now = Date.now();
      const validKeys: string[] = [];

      for (const key of keys) {
        const entry = this.loadEntry<unknown>(key);
        if (entry && entry.expireTime > now) {
          validKeys.push(key);
        } else {
          this.storage.removeItem(key);
          count++;
        }
      }

      this.storage.setItem(STORAGE_KEYS, JSON.stringify(validKeys));
    } catch {
      // ignore
    }
    return count;
  }
}
