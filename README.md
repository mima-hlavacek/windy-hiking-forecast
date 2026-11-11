# Second Layer Overlay Windy Plugin

Windy plugin that draws a second weather layer on top of the overlay Windy shows. The second layer
is drawn as an ordered-dither pattern, so the base overlay's colours stay readable underneath. For
example, the default shows clouds and rain as white and black patterns over the temperature map.

Windy's overlay menu still controls the base overlay. The plugin's selector controls the dithered
layer.

## Panel

- **Dithered layer:** offers every Windy layer that has one value per pixel, in the order of
  Windy's overlay menu. Examples are temperature, wind, waves, pressure and air quality. It also
  offers the categorical layers UV index, fog and air quality index, and clouds with rain. The
  list is built at runtime from Windy's own layer definitions. Layers drawn by other renderers
  aren't offered, for example accumulations, radar, satellite, turbulence and sea temperature.
- **Model and level** (the row under the selector): the padlock button ties the dithered layer to
  the base layer, which is the default. While it is locked, the model and level selects are
  disabled and show what the dithered layer follows: the base layer's level, and the model Windy
  would pick for the dithered layer (for example ECMWF WAM for waves over an ECMWF base, or CAMS
  for air quality). Click the padlock to unlock, and the model and level are then chosen in the
  selects, for each dithered layer separately. That lets you compare a parameter across models or
  levels, or draw a forecast over radar or satellite. Like Windy's model switch, the model list
  offers the global models plus the regional ones covering the view, sorted by name. The level
  select is only shown for layers with levels (wind, temperature, dew point, humidity) and lists
  the levels the chosen model offers. A level a model doesn't offer falls back to the surface, as
  in Windy.
- **Legend:** one bar per pattern, with ticks in your units.
- **Thresholds** (collapsible, starts collapsed on phones and tablets): each row reads "above
  _value_" and has a density, next to a swatch of its pattern. A pixel gets the density of the
  highest threshold it exceeds.
    - A density is the number of cells drawn of every 64, from 0 to 64: the pattern is an 8×8
      ordered dither, so each number is a different pattern.
    - A typed value or density applies on Enter or when the field loses focus. A value equal to
      another row's replaces that row.
    - You can add and remove rows (up to 16), and each pattern's colour can be changed.
    - Categorical layers have one row per category instead.
    - "Reset to defaults" restores the selected layer's thresholds, densities and colours.

The default thresholds come from Windy's legend for the layer, with densities rising by one cell
per legend step, starting at 0/64. Categorical layers start at 1/64 and add one cell per category.
Their legends carry no values, so at startup each category's lower bound is searched for in the
layer's value range, where Windy's unit conversion starts naming that category; a layer whose
categories aren't all found is left out.
The clouds-and-rain layer defaults to 10 / 59 / 89 % clouds at densities of 1 / 2 / 3, and
0.5 / 2 / 5 / 10 / 20 mm rain at densities of 10 / 15 / 20 / 25 / 30.

Thresholds belong to a layer, not to a level. Windy's legends fit surface values, so upper levels
may need edited thresholds: with the defaults, temperature at 300 hPa lies below the first
threshold and draws no pattern, and wind at 250 hPa reaches the highest density almost everywhere.
Edited thresholds then apply to every level of that layer.

The pattern is hidden, and the panel shows "Not available for this time", when the dithered layer's
model has no forecast step close enough to the selected time: further from it than half a step
beyond the model's first or last step, and further than the base layer's own nearest step. Models
run on different cycles, and regional models end after about two days. When none of the dithered
layer's tiles in view can be loaded (for example offline), the pattern is hidden and the panel
shows "Could not load this layer". Moving the map, the browser going back online, or a change of
time, model or layer tries again. Single tiles that fail to load stay empty until the map moves.

## Units

Thresholds are entered and shown in the units selected in Windy, at the precision Windy uses for
them. They are stored in the layer's base units, so changing units only changes how they are shown.

## Picker

Clicking the map opens a draggable marker. It shows the base overlay's value, the dithered layer's
value, and the wind when Windy animates wind particles over the base overlay. The dithered layer's
row names its model and level when they differ from the base layer's (for example "Temperature ·
GFS" or "Wind · 850hPa"), and is left out when it would repeat the base row. The wind row is left
out while the dithered layer is wind from the model and level the particles show: usually the base
layer's, but ECMWF at the surface over the air-quality and fire-danger layers, among others. A
value that can't be read within 3 seconds, for example because the marker is outside the view,
shows as "-". The detail button opens Windy's forecast for that location.

## Persistence

The **Settings** section below Thresholds offers **Remember last second layer** and
**Remember last base layer**, both on by default. On plugin startup, these restore the last
dithered layer and base overlay respectively. With remembering disabled, the second layer starts
with clouds and rain, and the base overlay stays on Windy's current selection. These options
take effect on the next startup; changing them leaves the displayed layers in place.

The last layers, these preferences and your changes are saved in the browser's local storage under the key
`windy-plugin-second-layer-overlay:settings`. Changing a threshold or a density saves all of that
pattern's thresholds and densities, and changing a colour saves only the colour. Whatever isn't
saved keeps its default, so a pattern that was only recoloured still takes its thresholds from
Windy's legend (clouds with rain and the categorical layers use the plugin's own defaults).

An unlocked layer's model and level are saved for that layer and deleted when it is locked again.
"Reset to defaults" doesn't change them.

## Development

- Install dependencies with `npm i`
- Start local development with `npm start`
- Open <https://www.windy.com/developer-mode>
- Load the plugin from <https://localhost:9999/plugin.js>

Checks:

- `npm test` runs the unit tests (vitest and fast-check)
- `npx tsc --noEmit -p .` type-checks the TypeScript modules
- `npx eslint src` lints the sources

Besides the plugin API, the plugin uses Windy modules typed in `@windycom/plugin-devtools` (layer
definitions, render parameters, tile decoding, tile auth parameters), so check it again after Windy
updates.

## Publishing

Plugin metadata is defined in [src/pluginConfig.ts](src/pluginConfig.ts), and package metadata is kept in `package.json` for Windy publishing compatibility.

To publish through GitHub Actions:

- increment the version in both `src/pluginConfig.ts` and `package.json`
- run the `publish-plugin` workflow
- use the plugin URL emitted by the workflow logs

Windy publishing guide: <https://docs.windy-plugins.com/getting-started/publishing-plugin.html>
