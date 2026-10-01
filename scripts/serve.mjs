// Serves a built app (default dist/) as Vercel does: its files, and every other path is the single-page app. Used by the tests.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] || 5510);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', process.argv[3] || 'dist');
const TYPES = {
    '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.json': 'application/json',
    '.csv': 'text/csv', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml', '.txt': 'text/plain'
};

http.createServer((req, res) => {
    let file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Test server on http://localhost:${port}`));
