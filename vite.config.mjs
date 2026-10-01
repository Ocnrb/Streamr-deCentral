// Build: the app's modules bundled and minified, Tailwind compiled, hashed file names (dist/). Files that are served
// as they are (vendored libraries, workers, service worker, icons, data) live in public/ and are copied unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// index.html is split in parts (src/html/: views, modals, layout): a line <!-- include: views/overview.html -->
// is replaced by that file, indented like the comment. The dev server reloads the page when a part changes.
function htmlIncludes(dir = 'src/html') {
    const root = path.resolve(dir);
    const expand = (html) => html.replace(/^([ \t]*)<!-- include: ([\w/.-]+) -->\r?$/gm, (_, indent, file) => {
        const full = path.resolve(root, file);
        if (!full.startsWith(root + path.sep)) throw new Error(`Include outside ${dir}: ${file}`);
        return expand(fs.readFileSync(full, 'utf8')).replace(/\r?\n$/, '').split(/\r?\n/).map(line => (line ? indent + line : line)).join('\n');
    });
    return {
        name: 'html-includes',
        transformIndexHtml: { order: 'pre', handler: expand },
        configureServer(server) {
            server.watcher.add(root);
            server.watcher.on('change', (file) => { if (file.startsWith(root + path.sep)) server.ws.send({ type: 'full-reload' }); });
        }
    };
}

export default defineConfig({
    plugins: [htmlIncludes(), tailwindcss()],
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2022',
        sourcemap: true,
        rollupOptions: {
            output: {
                // The libraries in a file of their own: cached across deploys, loaded alongside the app. d3 and Lucide
                // stay with the pages that use them (Visual, Race), loaded on demand.
                manualChunks: (id) => (/node_modules\/(?!d3|internmap|delaunator|robust-predicates|lucide)/.test(id) ? 'vendor' : undefined)
            }
        }
    },
    server: { port: 5500 },
    preview: { port: 5500 }
});
