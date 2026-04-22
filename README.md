# Hiking Forecast Windy Plugin

Windy plugin for evaluating hiking conditions at a glance by combining:

- temperature from the active Windy overlay
- wind speed and direction
- cloud cover
- rain intensity

The plugin renders a compact embedded panel and supports Windy's single-click picker for inspecting a chosen location on the map.

## Development

- Install dependencies with `npm i`
- Start local development with `npm start`
- Open <https://www.windy.com/developer-mode>
- Load the plugin from <https://localhost:9999/plugin.js>

## Publishing

Plugin metadata is defined in [src/pluginConfig.ts](src/pluginConfig.ts), and package metadata is kept in `package.json` for Windy publishing compatibility.

To publish through GitHub Actions:

- increment the version in both `src/pluginConfig.ts` and `package.json`
- run the `publish-plugin` workflow
- use the plugin URL emitted by the workflow logs

Windy publishing guide: <https://docs.windy-plugins.com/getting-started/publishing-plugin.html>
