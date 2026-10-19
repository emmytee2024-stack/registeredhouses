# Alimosho House Register

A coordinate-based directory for registered houses in Alimosho. Houses appear on an interactive MapLibre map and in a globally searchable, filterable directory.

## Run locally

```sh
npm install
npm start
```

## Import house coordinates

Use **Import CSV** to preview a comma-separated file before adding it. The preview supports column mapping, shows coordinate errors by row, and imports only after confirmation. Latitude and longitude are required and use WGS 84 decimal degrees. `name`, `houseNumber`, `address`, `area`/`neighborhood`, `street`, and `status` are optional. Valid rows are saved in this browser's local storage with an import date; invalid coordinate rows are skipped.

Use **Download CSV template** in the app for a starter file. No official house dataset is bundled; the map only plots records provided by the user.

The local-government selector uses a simplified set of the 20 Lagos LGA polygons from geoBoundaries / GRID3 (CC BY 4.0), with attribution on the map. Selecting an LGA scopes the register and map to that council. Alimosho also has a static OpenStreetMap relation 3718185 snapshot and 16 named locality points; its displayed neighborhood regions are inferred from those points and are not official survey boundaries. Built-in neighborhood points are available for Alimosho; other LGAs show area tags from imported records. Street labels come from the map tiles currently in view and are progressively available to global search. Satellite mode uses Esri imagery and reference labels with attribution shown on the map.

Choose **Start tracking** in the map controls to request browser permission and follow your live position. The map displays your WGS 84 latitude, longitude, and reported accuracy. Location access requires browser permission and a secure context (HTTPS, or localhost).

Choose **Start tracking** to record an ordered route while the browser watches your device location. The status shows each GPS update and explains when a weak fix is excluded. The route remains available when tracking is stopped and restarted in the same page session; the latest position marker is independent of the recorded route. Use **Follow: on/off**, **Return to location**, and **Fit full route** to control the map. Readings with accuracy worse than 100 meters, repeated points, and implausible jumps are excluded from the route to reduce GPS noise. Route history is held in memory and is cleared when the page is reloaded. Location permission must be allowed for the site, and device location services must be on.

Use **Custom** on the map to enter three or more WGS 84 latitude/longitude pairs and draw a custom boundary through those points. The map connects the last point back to the first and displays the mapped locality containing the first point when one can be identified; locality regions are inferred from mapped locality points and are not official survey boundaries. The custom boundary can be updated or cleared independently of the registered-house data.

## Field boundary surveying

Use the **Boundary survey** panel on the map to capture boundary points with the device GPS or add points by tapping the map. GPS capture requests a fresh device reading; the live tracking control continues to record the route separately. The panel shows the actual reported coordinates and accuracy, and does not substitute a sample or guessed location. Tap a point in the point list and then tap the map to move it; each point can also be removed. Press **Plot area** to close the boundary, shade a valid polygon, and fit the plotted area into the map view. Use the **Area fill color** picker to choose any color for that survey; its fill, outline, and point markers update together, and each saved area remembers its own color. Self-crossing or repeated-point polygons are reported and are not filled or measured until corrected.

Area and perimeter are approximate WGS 84 calculations. Registered houses are classified as inside or outside the currently selected valid boundary; no classification is made while it is open or invalid. Name and save valid areas to keep multiple independently shaded boundaries. Saved survey areas and edits are stored in this browser's local storage and remain available after refresh on the same browser/device.

These are field observations only. GPS accuracy varies with device, weather, buildings, and signal conditions; map taps are approximate too. A GPS reading or calculated polygon is not an official cadastral, land, or property boundary and must not be used as legal evidence or to settle a land dispute.

## Checks

```sh
npm test -- --watchAll=false
npm run build
```

### Test on Android

1. Install dependencies and run the app locally with `npm install` and `npm start`; run `npm test -- --watchAll=false` and `npm run build` on the development computer.
2. Make the running app available over **HTTPS** (for example, use your normal HTTPS deployment or a trusted HTTPS development tunnel). Android Chrome blocks geolocation on an ordinary LAN HTTP address such as `http://192.168.x.x:3000`; `localhost` is secure only on the device hosting it.
3. Open that HTTPS address in Chrome on the phone, grant the site precise location permission, and make sure Android Location is enabled. Walk to several positions and use **Capture GPS point** at each one; verify coordinates and accuracy update from the device. To make walking movement add boundary vertices automatically, enable **Capture walking track as boundary points**, start GPS tracking, and walk the perimeter. Stop tracking when finished; then plot and review the boundary points before saving. Accepted fixes need accuracy of 100 m or better and at least 2 m of movement, so noisy or very small changes are not added. Start/stop tracking without that option to record a separate route only.
4. Tap **Add point on map** and tap several locations. Close a valid boundary and check the shaded polygon, area, perimeter, and inside/outside house counts. Select a listed point and tap elsewhere on the map to move it; remove a point and confirm the outline/measurements update. Try a crossing shape to see the validation explanation.
5. Name and save two areas, switch between them using **Saved areas**, and refresh the page. Confirm both remain shaded and reopen correctly. Test denied permission in Android site settings and verify GPS capture reports the failure without inserting a point.
