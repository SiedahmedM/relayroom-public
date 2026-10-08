import { ApiError } from "./model.js";

export class RateLimiter {
  private buckets = new Map<string, number[]>();

  check(key: string, limit: number, windowMs: number): void {
    const cutoff = Date.now() - windowMs;
    const recent = (this.buckets.get(key) ?? []).filter((time) => time > cutoff);
    if (recent.length >= limit) throw new ApiError(429, "rate_limited", "Too many requests. Try again shortly.");
    recent.push(Date.now());
    this.buckets.set(key, recent);
    if (this.buckets.size > 10_000) {
      for (const [bucketKey, values] of this.buckets) {
        if (!values.some((time) => time > cutoff)) this.buckets.delete(bucketKey);
      }
    }
  }
}
