import sveltePreprocess from 'svelte-preprocess';

// For tools that compile the components on their own, such as svelte-check. The build passes its
// preprocessing to rollup-plugin-svelte in rollup.config.js and doesn't read this file; the options
// mirror the build's (TypeScript scripts, less styles with `math: 'always'`).
export default {
    preprocess: sveltePreprocess({ less: { math: 'always' } }),
};
