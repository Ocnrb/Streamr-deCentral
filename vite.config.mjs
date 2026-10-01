// Build: the app's modules bundled and minified, Tailwind compiled, hashed file names (dist/). Files that are served
// as they are (vendored libraries, workers, service worker, icons, data) live in public/ and are copied unchanged.
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
    plugins: [tailwindcss()],
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2022',
        sourcemap: true,
        rollupOptions: {
            output: {
                // The libraries in a file of their own: cached across deploys, loaded alongside the app
                manualChunks: { vendor: ['ethers', 'chart.js', 'leaflet'] }
            }
        }
    },
    server: { port: 5500 },
    preview: { port: 5500 }
});
