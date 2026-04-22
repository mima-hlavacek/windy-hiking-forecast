import type { ExternalPluginConfig } from '@windy/interfaces';

const config: ExternalPluginConfig = {
    name: 'windy-plugin-hiking-forecast',
    version: '0.1.0',
    icon: '🥾',
    title: 'Hiking Forecast',
    description: 'Combined forecast showing temperature, wind, clouds, and rain.',
    author: 'Míma Hlaváček',
    repository: 'https://github.com/mima-hlavacek/windy-hiking-forecast',
    desktopUI: 'embedded',
    mobileUI: 'small',
    routerPath: '/hiking-forecast',
    listenToSingleclick: true,
    private: true,
};

export default config;
