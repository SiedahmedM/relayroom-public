import { ApiError, MESSAGE_KINDS, type MessageKind } from "./model.js";

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_body", "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function textField(
  body: Record<string, unknown>,
  key: string,
  options: { min?: number; max: number; optional?: boolean; fallback?: string },
): string | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === "") {
    if (options.fallback !== undefined) return options.fallback;
    if (options.optional) return undefined;
    throw new ApiError(400, "invalid_field", `${key} is required.`);
  }
  if (typeof raw !== "string") throw new ApiError(400, "invalid_field", `${key} must be text.`);
  const value = raw.trim();
  if (value.length < (options.min ?? 1) || Buffer.byteLength(value, "utf8") > options.max) {
    throw new ApiError(400, "invalid_field", `${key} must have at least ${options.min ?? 1} characters and at most ${options.max} UTF-8 bytes.`);
  }
  return value;
}

export function integerField(
  body: Record<string, unknown>,
  key: string,
  options: { min: number; max: number; optional?: boolean; fallback?: number },
): number | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) {
    if (options.fallback !== undefined) return options.fallback;
    if (options.optional) return undefined;
    throw new ApiError(400, "invalid_field", `${key} is required.`);
  }
  if (!Number.isInteger(raw) || Number(raw) < options.min || Number(raw) > options.max) {
    throw new ApiError(400, "invalid_field", `${key} must be an integer from ${options.min} to ${options.max}.`);
  }
  return Number(raw);
}

export function booleanField(
  body: Record<string, unknown>,
  key: string,
  options: { optional?: boolean; fallback?: boolean } = {},
): boolean | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) {
    if (options.fallback !== undefined) return options.fallback;
    if (options.optional) return undefined;
    throw new ApiError(400, "invalid_field", `${key} is required.`);
  }
  if (typeof raw !== "boolean") throw new ApiError(400, "invalid_field", `${key} must be true or false.`);
  return raw;
}

export function messageKind(value: unknown): MessageKind {
  const kind = value ?? "message";
  if (typeof kind !== "string" || !MESSAGE_KINDS.includes(kind as MessageKind)) {
    throw new ApiError(400, "invalid_field", `kind must be one of: ${MESSAGE_KINDS.join(", ")}.`);
  }
  return kind as MessageKind;
}

export function mentionsFrom(body: string): string[] {
  const found = body.matchAll(/(^|\s)@([A-Za-z0-9][A-Za-z0-9_.-]{0,63})/g);
  return [...new Set([...found].map((match) => match[2]!))];
}
