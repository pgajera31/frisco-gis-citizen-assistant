import L, { type GeoJSON as LeafletGeoJSON, type Layer } from "leaflet";
import "leaflet/dist/leaflet.css";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { GeoJSON, MapContainer, ScaleControl, TileLayer, useMap } from "react-leaflet";
import { featureStyle, KIND_LABELS, legendColor, mphColor, pointStyle, STATUS_COLORS } from "../mapStyles";
import type { MapCollection, MapFeature, MapFeatureProps, MapKind } from "../types";

const FRISCO_CENTER: [number, number] = [33.1507, -96.8236];

/** Build popup content with DOM APIs (textContent) so GIS text can never inject HTML. */
function popupContent(p: MapFeatureProps): HTMLElement {
  const root = document.createElement("div");
  root.className = "popup";
  const kind = document.createElement("div");
  kind.className = "popup-kind";
  kind.textContent = KIND_LABELS[p.kind] ?? p.kind;
  const title = document.createElement("strong");
  title.textContent = p.label;
  root.append(kind, title);
  for (const line of p.details ?? []) {
    if (!line) continue;
    const d = document.createElement("div");
    d.textContent = line;
    root.append(d);
  }
  return root;
}

interface Props {
  data: MapCollection | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

function FitToData({ data, selectedId, layers }: { data: MapCollection | null; selectedId: string | null; layers: React.RefObject<Map<string, Layer>> }) {
  const map = useMap();
  const fit = useCallback(() => {
    if (!data || data.features.length === 0) return;
    const bounds = L.geoJSON(data as never).getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
  }, [data, map]);
  useEffect(() => {
    if (map.getSize().x > 0) fit();
  }, [fit, map]);
  // When the map was hidden (mobile chat tab), fit again once it becomes visible.
  useEffect(() => {
    let wasHidden = map.getContainer().clientWidth === 0;
    const ro = new ResizeObserver(() => {
      const hidden = map.getContainer().clientWidth === 0;
      map.invalidateSize();
      if (wasHidden && !hidden) fit();
      wasHidden = hidden;
    });
    ro.observe(map.getContainer());
    return () => ro.disconnect();
  }, [fit, map]);
  useEffect(() => {
    if (!selectedId) return;
    const layer = layers.current?.get(selectedId);
    if (!layer || map.getSize().x === 0) return;
    const b = (layer as L.Polyline).getBounds?.();
    if (b && b.isValid()) map.fitBounds(b, { padding: [48, 48], maxZoom: 17 });
    else if ((layer as L.CircleMarker).getLatLng) map.setView((layer as L.CircleMarker).getLatLng(), Math.max(map.getZoom(), 16));
    (layer as L.Layer & { openPopup?: () => void }).openPopup?.();
  }, [selectedId, layers, map]);
  return null;
}

function Legend({ data }: { data: MapCollection | null }) {
  const kinds = useMemo(() => [...new Set((data?.features ?? []).map((f) => f.properties.kind))] as MapKind[], [data]);
  const mphs = useMemo(
    () => [...new Set((data?.features ?? []).filter((f) => f.properties.kind === "speed-segment").map((f) => Number(f.properties.styleValue)))].sort((a, b) => a - b),
    [data],
  );
  const statuses = useMemo(
    () => [...new Set((data?.features ?? []).filter((f) => f.properties.kind === "road-project").map((f) => String(f.properties.styleValue)))],
    [data],
  );
  if (!kinds.length) return null;
  return (
    <div className="legend" aria-label="Map legend">
      <strong>Legend</strong>
      <ul>
        {kinds
          .filter((k) => k !== "speed-segment" && k !== "road-project")
          .map((k) => (
            <li key={k}>
              <span className="swatch" style={{ background: legendColor(k) }} aria-hidden="true" />
              {KIND_LABELS[k]}
            </li>
          ))}
        {mphs.map((m) => (
          <li key={`mph-${m}`}>
            <span className="swatch line" style={{ background: mphColor(m) }} aria-hidden="true" />
            {m} mph
          </li>
        ))}
        {statuses.map((s) => (
          <li key={`st-${s}`}>
            <span className="swatch line" style={{ background: STATUS_COLORS[s] ?? "#d9480f" }} aria-hidden="true" />
            Project: {s}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function MapView({ data, selectedId, onSelect }: Props) {
  const layers = useRef(new Map<string, Layer>());
  const geoRef = useRef<LeafletGeoJSON | null>(null);
  // Re-mount the GeoJSON layer whenever the result set changes.
  const dataKey = useMemo(() => (data ? `${data.features.length}-${data.features.map((f) => f.properties.id).join(",").slice(0, 2000)}` : "empty"), [data]);
  // Forget layers from the previous result set (runs during render, before the new layers register).
  useMemo(() => layers.current.clear(), [dataKey]);

  // Restyle on selection change without re-mounting.
  useEffect(() => {
    geoRef.current?.eachLayer((layer) => {
      const f = (layer as L.Layer & { feature?: MapFeature }).feature;
      if (!f) return;
      const sel = f.properties.id === selectedId;
      if ((layer as L.Path).setStyle && !(layer instanceof L.CircleMarker)) (layer as L.Path).setStyle(featureStyle(f.properties, sel));
      if (layer instanceof L.CircleMarker) layer.setStyle(pointStyle(f.properties.kind, sel));
    });
  }, [selectedId]);

  return (
    <div className="map-wrap">
      <MapContainer
        center={FRISCO_CENTER}
        zoom={12}
        className="map"
        scrollWheelZoom
        keyboard
        aria-label="Interactive map of search results in Frisco, Texas"
      >
        <TileLayer
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"
          attribution="Basemap: Esri, HERE, Garmin, USGS, OpenStreetMap contributors | GIS data: City of Frisco"
          maxZoom={19}
        />
        <ScaleControl imperial metric={false} />
        {data && data.features.length > 0 && (
          <GeoJSON
            key={dataKey}
            ref={geoRef}
            data={data as never}
            style={(f) => featureStyle((f as MapFeature).properties, false)}
            pointToLayer={(f, latlng) => L.circleMarker(latlng, pointStyle((f as MapFeature).properties.kind, false))}
            onEachFeature={(f, layer) => {
              const p = (f as MapFeature).properties;
              layers.current.set(p.id, layer);
              layer.bindPopup(popupContent(p), { maxWidth: 280 });
              layer.on("click", () => onSelect(p.id));
              layer.bindTooltip(p.label, { sticky: true, direction: "top", opacity: 0.9 });
            }}
          />
        )}
        <FitToData data={data} selectedId={selectedId} layers={layers} />
      </MapContainer>
      <Legend data={data} />
      {(!data || data.features.length === 0) && (
        <div className="map-empty" role="note">Results from your questions will appear on this map.</div>
      )}
    </div>
  );
}
