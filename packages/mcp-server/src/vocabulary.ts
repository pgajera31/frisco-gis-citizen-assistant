/**
 * Pure (network-free) vocabulary shared by the MCP tools and the backend's
 * offline planner: park amenities, trail types and CIP statuses exactly as they
 * appear in the City data, plus everyday synonyms residents use.
 */

/** Canonical amenities: park-layer field name → display label + accepted synonyms. */
export const AMENITIES: { field: string; label: string; synonyms: string[] }[] = [
  { field: "Amphitheater", label: "Amphitheater", synonyms: ["amphitheatre", "outdoor stage", "stage"] },
  { field: "BaseballSoftball", label: "Baseball/Softball", synonyms: ["baseball", "softball", "baseball field", "softball field", "ball field", "diamond"] },
  { field: "Basketball", label: "Basketball", synonyms: ["basketball court", "basketball courts", "hoops", "basketball hoop"] },
  { field: "BattingCages", label: "Batting Cages", synonyms: ["batting cage"] },
  { field: "Biking", label: "Biking", synonyms: ["bike", "bikes", "bicycle", "cycling", "bike trail"] },
  { field: "MountainBiking", label: "Mountain Biking", synonyms: ["mountain bike", "mtb", "mountain bike trail"] },
  { field: "Cricket", label: "Cricket", synonyms: ["cricket pitch", "cricket field"] },
  { field: "DiscGolf", label: "Disc Golf", synonyms: ["frisbee golf", "disc golf course", "frolf"] },
  { field: "DogPark", label: "Dog Park", synonyms: ["dog", "dogs", "off leash", "off-leash", "dog run"] },
  { field: "Fishing", label: "Fishing", synonyms: ["fish", "fishing pond"] },
  { field: "FitnessEquipment", label: "Fitness Equipment", synonyms: ["fitness", "exercise equipment", "outdoor gym", "workout equipment"] },
  { field: "HorseshoePit", label: "Horseshoe Pit", synonyms: ["horseshoes", "horseshoe"] },
  { field: "CommunityGarden", label: "Community Garden", synonyms: ["garden", "gardens"] },
  { field: "Parking", label: "Parking", synonyms: ["parking lot", "car park"] },
  { field: "Pickleball", label: "Pickleball", synonyms: ["pickleball court", "pickleball courts"] },
  { field: "PicnicAreas", label: "Picnic Areas", synonyms: ["picnic", "picnic area", "picnic tables", "pavilion"] },
  { field: "Playground", label: "Playground", synonyms: ["playgrounds", "play area", "play equipment", "jungle gym", "play structure"] },
  { field: "Pond", label: "Pond", synonyms: ["ponds", "lake"] },
  { field: "PracticeGameFields", label: "Practice & Game Fields", synonyms: ["practice fields", "game fields", "athletic fields", "sports fields", "fields"] },
  { field: "PublicArt", label: "Public Art", synonyms: ["art", "sculpture", "mural"] },
  { field: "Restrooms", label: "Restrooms", synonyms: ["restroom", "bathroom", "bathrooms", "toilets", "toilet"] },
  { field: "SkatePark", label: "Skate Park", synonyms: ["skate", "skateboard", "skateboarding", "skatepark"] },
  { field: "SplashPad", label: "Splash Pad", synonyms: ["splash", "splashpad", "spray park", "spray ground", "sprayground"] },
  { field: "TrailConnection", label: "Trail Connection", synonyms: ["trail access", "connects to trail"] },
  { field: "Tennis", label: "Tennis", synonyms: ["tennis court", "tennis courts"] },
  { field: "Volleyball", label: "Volleyball", synonyms: ["volleyball court", "sand volleyball"] },
  { field: "WalkingTrail", label: "Walking Trail", synonyms: ["walking trails", "walking path", "walking", "trail", "trails", "jogging"] },
  { field: "WaterFeatures", label: "Water Features", synonyms: ["water feature", "fountain"] },
  { field: "Wildflowers", label: "Wildflowers", synonyms: ["wildflower", "flowers"] },
  { field: "Football", label: "Football", synonyms: ["football field"] },
  { field: "Racquetball", label: "Racquetball", synonyms: ["racquetball court"] },
  { field: "Swimming", label: "Swimming", synonyms: ["pool", "swimming pool", "swim"] },
  { field: "Museum", label: "Museum", synonyms: ["museums", "history"] },
  { field: "AccessibleTrails", label: "Accessible Trails", synonyms: ["accessible trail", "ada trail", "wheelchair accessible trail"] },
];

export const AMENITY_LABELS = AMENITIES.map((a) => a.label);

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Map free text ("basketball courts", "splash pads") to a canonical amenity, or null. */
export function normalizeAmenity(input: string): (typeof AMENITIES)[number] | null {
  const n = normalizeText(input);
  if (!n) return null;
  const singular = n.replace(/s$/, "");
  for (const a of AMENITIES) {
    const options = [a.label, a.field, ...a.synonyms].map(normalizeText);
    if (options.includes(n) || options.includes(singular)) return a;
  }
  return null;
}


/** Trail classifications present in the TrailType field (verified distinct values). */
export const TRAIL_TYPES = ["Regional", "Parkway", "Local", "Nature", "Bike Only"] as const;

/** CIP Status / Type coded values (verified). */
export const CIP_STATUSES = ["Construction", "Design", "Planning", "On Hold", "Completed"] as const;
export const CIP_TYPES = ["Road", "Utility", "Parks"] as const;
