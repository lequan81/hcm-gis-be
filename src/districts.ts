/**
 * HCMC District Definitions
 *
 * WGS84 bounding boxes for all 22 districts.
 * Tile range computation with configurable border overlap.
 */

export interface District {
  name: string;
  bbox: [number, number, number, number]; // [lon_min, lat_min, lon_max, lat_max]
}

export const DISTRICTS: Record<string, District> = {
  // ── Urban districts (Quận) ──
  quan_1: { name: "Quận 1", bbox: [106.680, 10.760, 106.720, 10.800] },
  quan_3: { name: "Quận 3", bbox: [106.660, 10.770, 106.700, 10.800] },
  quan_4: { name: "Quận 4", bbox: [106.690, 10.740, 106.720, 10.770] },
  quan_5: { name: "Quận 5", bbox: [106.640, 10.740, 106.680, 10.770] },
  quan_6: { name: "Quận 6", bbox: [106.620, 10.730, 106.660, 10.760] },
  quan_7: { name: "Quận 7", bbox: [106.690, 10.700, 106.760, 10.760] },
  quan_8: { name: "Quận 8", bbox: [106.620, 10.710, 106.680, 10.750] },
  quan_10: { name: "Quận 10", bbox: [106.650, 10.760, 106.680, 10.790] },
  quan_11: { name: "Quận 11", bbox: [106.630, 10.750, 106.660, 10.780] },
  quan_12: { name: "Quận 12", bbox: [106.600, 10.830, 106.680, 10.900] },
  binh_tan: { name: "Bình Tân", bbox: [106.580, 10.730, 106.640, 10.790] },
  binh_thanh: { name: "Bình Thạnh", bbox: [106.680, 10.790, 106.730, 10.830] },
  go_vap: { name: "Gò Vấp", bbox: [106.640, 10.810, 106.700, 10.860] },
  phu_nhuan: { name: "Phú Nhuận", bbox: [106.670, 10.790, 106.700, 10.810] },
  tan_binh: { name: "Tân Bình", bbox: [106.630, 10.780, 106.680, 10.830] },
  tan_phu: { name: "Tân Phú", bbox: [106.610, 10.780, 106.660, 10.820] },
  // ── TP Thủ Đức (merged Quận 2 + Quận 9 + Quận Thủ Đức in 2021) ──
  thu_duc: { name: "TP Thủ Đức", bbox: [106.710, 10.730, 106.840, 10.910] },
  // ── Rural districts (Huyện) ──
  binh_chanh: { name: "Huyện Bình Chánh", bbox: [106.480, 10.620, 106.620, 10.750] },
  can_gio: { name: "Huyện Cần Giờ", bbox: [106.730, 10.320, 107.010, 10.560] },
  cu_chi: { name: "Huyện Củ Chi", bbox: [106.480, 10.920, 106.680, 11.160] },
  hoc_mon: { name: "Huyện Hóc Môn", bbox: [106.550, 10.850, 106.680, 10.950] },
  nha_be: { name: "Huyện Nhà Bè", bbox: [106.650, 10.600, 106.770, 10.720] },
};

export const URBAN_KEYS = [
  "quan_1", "quan_3", "quan_4", "quan_5", "quan_6", "quan_7",
  "quan_8", "quan_10", "quan_11", "quan_12",
  "binh_tan", "binh_thanh", "go_vap", "phu_nhuan",
  "tan_binh", "tan_phu", "thu_duc",
];

export const ALL_KEYS = Object.keys(DISTRICTS);

// ─── Tile math ───────────────────────────────────────────────

function lonToTileX(lon: number, n: number): number {
  return Math.floor(((lon + 180) / 360) * n);
}

function latToTileY(lat: number, n: number): number {
  const latRad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
}

export interface TileRange {
  xMin: number; yMin: number;
  xMax: number; yMax: number;
  count: number;
}

export function bboxToTileRange(
  bbox: [number, number, number, number],
  zoom: number,
  overlap: number = 3,
): TileRange {
  const n = 2 ** zoom;
  const [lonMin, latMin, lonMax, latMax] = bbox;

  let xMin = lonToTileX(lonMin, n) - overlap;
  let xMax = lonToTileX(lonMax, n) + overlap;
  let yMin = latToTileY(latMax, n) - overlap;
  let yMax = latToTileY(latMin, n) + overlap;

  xMin = Math.max(0, xMin);
  yMin = Math.max(0, yMin);
  xMax = Math.min(n - 1, xMax);
  yMax = Math.min(n - 1, yMax);

  return {
    xMin, yMin, xMax, yMax,
    count: (xMax - xMin + 1) * (yMax - yMin + 1),
  };
}

export function getTilesForDistrict(
  key: string,
  zoom: number = 16,
  overlap: number = 3,
): { tiles: [number, number, number][]; range: TileRange } {
  const d = DISTRICTS[key];
  if (!d) throw new Error(`Unknown district: ${key}`);

  const range = bboxToTileRange(d.bbox, zoom, overlap);
  const tiles: [number, number, number][] = [];
  for (let x = range.xMin; x <= range.xMax; x++) {
    for (let y = range.yMin; y <= range.yMax; y++) {
      tiles.push([zoom, x, y]);
    }
  }
  return { tiles, range };
}
