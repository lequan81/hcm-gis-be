import { env } from "../config";
import { DISTRICTS, getTilesForDistrict, URBAN_KEYS, ALL_KEYS } from "../utils/districts";
import { corsHeaders } from "../utils/response";
import { cacheGet, cacheSet, isRedisAvailable } from "../utils/redis";

const CACHE_KEY = "districts";
const CACHE_TTL = 3600; // 1 hour

export class DistrictsController {
  /** In-memory fallback cache */
  private static memCache: string | null = null;
  
  static async getDistricts(req: Request) {
    const origin = req.headers.get("origin");
    
    // 1. Try Redis cache
    if (isRedisAvailable()) {
      const cached = await cacheGet(CACHE_KEY);
      if (cached) {
        return new Response(cached, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=3600",
            "X-Cache": "HIT-REDIS",
            ...corsHeaders(origin),
          },
        });
      }
    }

    // 2. Try in-memory cache
    if (this.memCache) {
      return new Response(this.memCache, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
          "X-Cache": "HIT-MEM",
          ...corsHeaders(origin),
        },
      });
    }

    // 3. Compute fresh
    const districtInfos = ALL_KEYS.map(key => {
      const d = DISTRICTS[key];
      const { tiles } = getTilesForDistrict(key, env.ZOOM, env.TILE_OVERLAP);
      return { key, name: d.name, tiles: tiles.length, bbox: d.bbox };
    });
    const json = JSON.stringify({ districts: districtInfos, urbanKeys: URBAN_KEYS, allKeys: ALL_KEYS });

    // Store in both caches
    this.memCache = json;
    await cacheSet(CACHE_KEY, json, CACHE_TTL);

    return new Response(json, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        "X-Cache": "MISS",
        ...corsHeaders(origin),
      },
    });
  }
}
