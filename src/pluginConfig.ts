import type { ExternalPluginConfig } from '@windy/interfaces';

const config: ExternalPluginConfig = {
    name: 'windy-plugin-second-layer-overlay',
    version: '0.1.5',
    icon: '☰',
    title: 'Second Layer Overlay',
    description: 'Draws a second weather layer as an overlay. Example: View clouds (which include precipitation) over temperature (which includes wind particles) to know whether to go for a hike or read a book.',
    author: 'Míma Hlaváček',
    repository: 'https://github.com/mima-hlavacek/windy-hiking-forecast',
    desktopUI: 'embedded',
    mobileUI: 'small',
    routerPath: '/second-layer-overlay',
    listenToSingleclick: true,
    private: true,
};

export default config;
