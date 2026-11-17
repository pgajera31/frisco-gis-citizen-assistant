import type { PathOptions } from "leaflet";
import type { MapFeatureProps, MapKind } from "./types";

/** Speed-limit color ramp (low → high). Chosen to stay distinguishable for common color-vision deficiencies. */
export function mphColor(mph: number): string {
  if (mph <= 20) return "#1a9850";
  if (mph <= 25) return "#66bd63";
  if (mph <= 30) return "#9acd32";
  if (mph <= 35) return "#c9b800";
  if (mph <= 40) return "#f2a900";
  if (mph <= 45) return "#f46d43";
  if (mph <= 50) return "#d73027";
  if (mph <= 55) return "#a50026";
  return "#5c0018";
}

export const STATUS_COLORS: Record<string, string> = {
  Construction: "#d9480f",
  Design: "#e8a400",
  Planning: "#5c7cfa",
  "On Hold": "#868e96",
  Completed: "#2b8a3e",
};

export function featureStyle(p: MapFeatureProps, selected: boolean): PathOptions {
  const weightBoost = selected ? 3 : 0;
  switch (p.kind) {
    case "park":
      return { color: "#2b8a3e", weight: 2 + weightBoost, fillColor: "#69db7c", fillOpacity: selected ? 0.55 : 0.35 };
    case "zoning":
      return { color: "#1c5fa8", weight: 3 + weightBoost, fillColor: "#74c0fc", fillOpacity: 0.25 };
    case "parcel":
      return { color: "#212529", weight: 2 + weightBoost, dashArray: "4 4", fillOpacity: 0.05 };
    case "proposed-zoning":
      return { color: "#e8590c", weight: 2 + weightBoost, dashArray: "6 6", fillColor: "#ffa94d", fillOpacity: 0.15 };
    case "trail":
      return {
        color: p.styleValue === "walking-loop" ? "#862e9c" : p.styleValue === "not-open" ? "#adb5bd" : "#0b7285",
        weight: 4 + weightBoost,
        dashArray: p.styleValue === "not-open" ? "6 6" : undefined,
        opacity: 0.9,
      };
    case "road-project":
      return { color: STATUS_COLORS[String(p.styleValue)] ?? "#d9480f", weight: 6 + weightBoost, opacity: 0.85 };
    case "traffic-closure":
      return { color: "#c92a2a", weight: 2 + weightBoost, fillColor: "#ff6b6b", fillOpacity: 0.5 };
    case "speed-segment":
      return { color: mphColor(Number(p.styleValue) || 0), weight: 5 + weightBoost, opacity: 0.9 };
    case "school-zone":
      return { color: "#fab005", weight: 9 + weightBoost, opacity: 0.6 };
    default:
      return { color: "#495057", weight: 2 + weightBoost };
  }
}

export function pointStyle(kind: MapKind, selected: boolean) {
  if (kind === "search-location") {
    return { radius: 9, color: "#ffffff", weight: 3, fillColor: "#c92a2a", fillOpacity: 1 };
  }
  return { radius: selected ? 8 : 6, color: "#ffffff", weight: 2, fillColor: "#e67700", fillOpacity: 0.95 };
}

export const KIND_LABELS: Record<MapKind, string> = {
  "search-location": "Searched location",
  park: "Park boundary",
  amenity: "Park amenity",
  trail: "Trail",
  zoning: "Zoning district",
  parcel: "Parcel",
  "proposed-zoning": "Pending zoning case",
  "road-project": "Road project",
  "traffic-closure": "Traffic closure",
  "speed-segment": "Street segment (speed limit)",
  "school-zone": "School zone",
};

/** Swatch color for the legend. */
export function legendColor(kind: MapKind): string {
  const s = featureStyle({ kind, id: "", label: "", styleValue: kind === "speed-segment" ? 45 : kind === "road-project" ? "Construction" : undefined }, false);
  if (kind === "search-location") return "#c92a2a";
  if (kind === "amenity") return "#e67700";
  return (s.fillColor as string) ?? (s.color as string);
}
