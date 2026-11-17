import { useEffect, useRef } from "react";

const GLOSSARY: [string, string][] = [
  ["GIS", "Geographic Information System — maps plus the data behind them (where things are and what they are)."],
  ["Layer", "One dataset on a map, such as all park boundaries or all street centerlines."],
  ["Straight-line distance", "Distance “as the crow flies”, not along roads or trails."],
  ["Park boundary", "The outline of the park property. Distances are measured to the closest edge, not to an entrance."],
  ["Zoning district", "The City's land-use category for an area (for example Single Family or Mixed Use). Rules for each district are in the Zoning Ordinance."],
  ["Planned Development (PD)", "An area with its own zoning ordinance that customises the base district rules."],
  ["Ordinance", "The City Council decision that set or changed the zoning; its number links to the official document."],
  ["CIP", "Capital Improvement Program — the City's list of planned and active infrastructure projects."],
  ["Walking loop", "A trail the City's data marks as a walking loop (usually a circuit inside a park)."],
  ["Street segment", "A piece of a street between intersections; one road can have different speed limits on different segments."],
  ["MCP", "Model Context Protocol — the open standard this prototype uses so the AI can call approved, read-only GIS tools."],
];

export default function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className="about" aria-labelledby="about-title" onClose={onClose} onCancel={onClose}>
      <div className="about-head">
        <h2 id="about-title">About this prototype</h2>
        <button type="button" className="btn-ghost" onClick={onClose} aria-label="Close about dialog">
          Close
        </button>
      </div>
      <p>
        This is a university capstone prototype (UT Dallas) built for the City of Frisco's IT/GIS team. It is <strong>not</strong> an official
        City service. It answers questions using the City's public ArcGIS layers through a Model Context Protocol (MCP) server that only
        allows approved, read-only queries.
      </p>
      <p>
        Every answer lists the data layers it used, when that data was last updated (when the City publishes it), and how the answer was
        derived. GIS data can lag behind conditions on the ground — please confirm important details with the City of Frisco.
      </p>
      <p>No account is needed. Your questions are kept only for this browser session to support follow-up questions.</p>
      <h3>Glossary</h3>
      <dl className="glossary">
        {GLOSSARY.map(([t, d]) => (
          <div key={t}>
            <dt>{t}</dt>
            <dd>{d}</dd>
          </div>
        ))}
      </dl>
    </dialog>
  );
}
