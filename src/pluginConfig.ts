import type { ExternalPluginConfig } from '@windy/interfaces';

const config: ExternalPluginConfig = {
    name: 'windy-plugin-second-layer-overlay',
    version: '0.1.0',
    icon: '▒',
    title: 'Second Layer Overlay',
    description: 'Draws a Windy weather layer as a dither pattern on top of the base overlay.',
    author: 'Míma Hlaváček',
    repository: 'https://github.com/mima-hlavacek/windy-hiking-forecast',
    desktopUI: 'embedded',
    mobileUI: 'small',
    routerPath: '/second-layer-overlay',
    listenToSingleclick: true,
    private: true,
};

export default config;
