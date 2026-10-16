import { Schema } from "effect";

export const CacheSizeGiB = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 }));
export const CacheVolume = Schema.Struct({ enabled: Schema.Boolean, sizeGiB: CacheSizeGiB });
export type CacheVolume = typeof CacheVolume.Type;
export const defaultCacheSizeGiB = 20;
