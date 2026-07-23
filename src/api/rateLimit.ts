interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimitOptions {
  /** Capacidade do balde: quantas requisições podem ocorrer em rajada. */
  capacity: number;
  /** Tokens repostos por segundo — a taxa sustentada. */
  refillPerSecond: number;
  /** Máximo de clientes rastreados; acima disso os mais antigos são descartados. */
  maxClients?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Tokens restantes após a decisão, arredondado para baixo. */
  remaining: number;
  /** Segundos até haver token disponível de novo (0 quando permitido). */
  retryAfterSeconds: number;
}

const DEFAULT_MAX_CLIENTS = 10_000;

/**
 * Token bucket por cliente.
 *
 * Escolhido em vez de janela fixa porque absorve rajadas legítimas (um pipeline disparando
 * alguns scans de uma vez) sem permitir carga sustentada acima da taxa — que é o que interessa
 * limitar quando cada requisição custa uma varredura de filesystem.
 *
 * O número de clientes rastreados é limitado: sem teto, um atacante variando o IP de origem
 * transformaria o próprio rate limiter em um vazamento de memória.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly maxClients: number;

  constructor(options: RateLimitOptions) {
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS;
  }

  check(clientId: string, nowMs: number = Date.now()): RateLimitDecision {
    const bucket = this.bucketFor(clientId, nowMs);

    const elapsedSeconds = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.lastRefillMs = nowMs;

    if (bucket.tokens < 1) {
      const secondsUntilToken = (1 - bucket.tokens) / this.refillPerSecond;
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(secondsUntilToken)) };
    }

    bucket.tokens -= 1;
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
  }

  get limit(): number {
    return this.capacity;
  }

  private bucketFor(clientId: string, nowMs: number): Bucket {
    const existing = this.buckets.get(clientId);
    if (existing) {
      // Reinsere para manter a ordem de uso no Map (usada pelo descarte por antiguidade).
      this.buckets.delete(clientId);
      this.buckets.set(clientId, existing);
      return existing;
    }

    if (this.buckets.size >= this.maxClients) {
      const oldest = this.buckets.keys().next();
      if (!oldest.done) this.buckets.delete(oldest.value);
    }

    const fresh: Bucket = { tokens: this.capacity, lastRefillMs: nowMs };
    this.buckets.set(clientId, fresh);
    return fresh;
  }
}
