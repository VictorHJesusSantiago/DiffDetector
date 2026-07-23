/** Fronteiras do histograma de latência, em segundos. */
const LATENCY_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

interface RouteKey {
  method: string;
  route: string;
  status: number;
}

interface HistogramState {
  bucketCounts: number[];
  sum: number;
  count: number;
}

function keyOf({ method, route, status }: RouteKey): string {
  return `${method}\u0000${route}\u0000${status}`;
}

function parseKey(key: string): RouteKey {
  const [method, route, status] = key.split("\u0000");
  return { method, route, status: Number(status) };
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Método RED (Rate, Errors, Duration) por rota, no formato de exposição do Prometheus.
 *
 * A duração é histograma, não média: a média esconde exatamente o que importa operacionalmente
 * — a cauda. O rótulo `route` usa o padrão registrado (`/scans/:id`) e nunca o caminho
 * concreto, para não explodir a cardinalidade com um valor por id de scan.
 */
export class MetricsRegistry {
  private readonly histograms = new Map<string, HistogramState>();

  observe(key: RouteKey, durationSeconds: number): void {
    const mapKey = keyOf(key);
    const state = this.histograms.get(mapKey) ?? {
      bucketCounts: new Array<number>(LATENCY_BUCKETS_SECONDS.length).fill(0),
      sum: 0,
      count: 0,
    };

    for (let index = 0; index < LATENCY_BUCKETS_SECONDS.length; index++) {
      if (durationSeconds <= LATENCY_BUCKETS_SECONDS[index]) state.bucketCounts[index]++;
    }
    state.sum += durationSeconds;
    state.count++;
    this.histograms.set(mapKey, state);
  }

  /** Contagem total de requisições observadas — usada pelos testes e pelo diagnóstico. */
  totalRequests(): number {
    let total = 0;
    for (const state of this.histograms.values()) total += state.count;
    return total;
  }

  render(): string {
    const lines: string[] = [
      "# HELP drift_http_request_duration_seconds Duração das requisições HTTP por rota.",
      "# TYPE drift_http_request_duration_seconds histogram",
    ];

    for (const [mapKey, state] of this.histograms) {
      const { method, route, status } = parseKey(mapKey);
      const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${status}"`;

      let cumulative = 0;
      for (let index = 0; index < LATENCY_BUCKETS_SECONDS.length; index++) {
        cumulative = state.bucketCounts[index];
        lines.push(
          `drift_http_request_duration_seconds_bucket{${labels},le="${LATENCY_BUCKETS_SECONDS[index]}"} ${cumulative}`,
        );
      }
      lines.push(`drift_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${state.count}`);
      lines.push(`drift_http_request_duration_seconds_sum{${labels}} ${state.sum}`);
      lines.push(`drift_http_request_duration_seconds_count{${labels}} ${state.count}`);
    }

    return lines.join("\n") + "\n";
  }

  reset(): void {
    this.histograms.clear();
  }
}

export const metrics = new MetricsRegistry();
