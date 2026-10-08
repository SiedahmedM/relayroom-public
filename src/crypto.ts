import { createHash, randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

export function hashSecret(value: string, pepper: string): string {
  return createHash("sha256").update(pepper).update("\0").update(value).digest("hex");
}

export function joinCode(): string {
  const bytes = randomBytes(12);
  let raw = "";
  for (let i = 0; i < 12; i += 1) raw += CROCKFORD[bytes[i]! & 31];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

export function normalizeJoinCode(value: string): string {
  return value.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/[O]/g, "0").replace(/[IL]/g, "1");
}

export function ulid(now = Date.now()): string {
  let time = BigInt(now);
  let head = "";
  for (let i = 0; i < 10; i += 1) {
    head = CROCKFORD[Number(time & 31n)] + head;
    time >>= 5n;
  }
  const entropy = randomBytes(10);
  let bits = 0;
  let bitCount = 0;
  let tail = "";
  for (const byte of entropy) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      tail += CROCKFORD[(bits >> bitCount) & 31];
      bits &= (1 << bitCount) - 1;
    }
  }
  return head + tail.slice(0, 16);
}
