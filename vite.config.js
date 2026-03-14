import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
    root: '.',
    publicDir: 'data',
    server: {
        port: 3000,
        open: true,
    },
    build: {
        outDir: 'dist',
    },
    // GitHub Pages serves from /<repo-name>/
    // Only apply base path for production builds; dev server uses /
    base: command === 'build' ? '/restaurant_navigator/' : '/',
}));
