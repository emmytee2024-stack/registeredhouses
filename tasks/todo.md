# Alimosho Registered Houses

## Plan
- [x] Review MapCN's map examples and installation requirements.
- [x] Set initial CSV intake defaults: latitude and longitude required; name, address, area, and status optional.
- [x] Add an interactive Alimosho map using MapLibre, following MapCN's map-first layout, markers, and popups while retaining the existing Create React App stack.
- [x] Show imported houses on the map and provide CSV import, browser persistence, and searchable records; do not invent registered-house data.
- [x] Verify coordinate plotting, invalid or missing coordinate handling, responsive behavior, and the production build.

## Review
Reference: https://www.mapcn.dev/ (MapCN uses MapLibre and its provided components expect Tailwind CSS and shadcn/ui; this repo currently has neither).

No source coordinates have been provided; the initial register is empty. CSV is the first-version intake format. Imported records are local to the browser and are not sent to a shared backend.

Verified: parser tests pass, a temporary two-row import produced clickable map popups and searchable/persistent directory results, and desktop/mobile layouts have no horizontal overflow. The production build passes with a non-fatal MapLibre bundler warning.

## Follow-up: Dark Map and Boundary
- [x] Switch the map and application surfaces to a high-contrast dark theme.
- [x] Remove broader place labels and use Alimosho only in the interface.
- [x] Bundle the verified OSM administrative polygon and draw its boundary beneath house points.
- [x] Suppress basemap country, state, city, and locality labels; show one Alimosho label inside the outline.
- [x] Verify boundary rendering, dark map visibility, and responsive layout.

Boundary source: OpenStreetMap relation 3718185 (ODbL; attribution remains on the map). The mapped outline is approximate, not a legal survey. Verified polygon request and map load, visible outline on desktop and mobile, four passing tests, and a successful production build with the existing non-fatal MapLibre bundler warning.

## Follow-up: Alimosho Areas
- [x] Add verified named localities inside the Alimosho boundary as map labels.
- [x] Show a clickable area list that focuses the map on a selected locality.
- [x] Verify the area list, map labels, and production build.


## Follow-up: Locality Details
- [x] Add street and address fields to CSV import and group them for the selected locality.
- [x] Filter map pins and registered houses to the selected locality using imported area values.
- [x] Verify both lists on selection and confirm map, mobile layout, tests, and build.

Nearby street names also come from rendered road-label features in the selected map view. Imported house matching uses the area field; imported street groups use the optional street column or address. Browser verification confirmed streets appear with zero houses, duplicate road labels are normalized, and map-only street entries focus the road. Five tests pass; production build succeeds with the non-fatal MapLibre bundler warning.

## Follow-up: UI Polish
- [x] Improve area and selected-locality hierarchy, contrast, and touch targets.
- [x] Add area house counts and a map legend.
- [x] Verify desktop and mobile layouts, tests, and production build.

Browser checks confirmed the legend does not overlap the map badge, the selected locality panel remains readable on mobile, and no horizontal overflow occurs.
