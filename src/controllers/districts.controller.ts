import { env } from "../config";
import { DISTRICTS, getTilesForDistrict, URBAN_KEYS, ALL_KEYS } from "../utils/districts";
import { corsHeaders } from "../utils/response";

export class DistrictsController {
  
  static getDistricts(req: Request) {
    const origin = req.headers.get("origin");
    
    const districtInfos = ALL_KEYS.map(key => {
      const d = DISTRICTS[key];
      const { tiles } = getTilesForDistrict(key, env.ZOOM, env.TILE_OVERLAP);
      return { key, name: d.name, tiles: tiles.length, bbox: d.bbox };
    });

    return new Response(JSON.stringify({ districts: districtInfos, urbanKeys: URBAN_KEYS, allKeys: ALL_KEYS }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        ...corsHeaders(origin),
      },
    });
  }
}
