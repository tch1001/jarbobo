import fs from 'fs';
import path from 'path';

const pairs = [
  ['node_modules/cytoscape/dist/cytoscape.min.js', 'media/vendor/cytoscape.min.js'],
  ['node_modules/dagre/dist/dagre.min.js', 'media/vendor/dagre.min.js'],
  ['node_modules/cytoscape-dagre/cytoscape-dagre.js', 'media/vendor/cytoscape-dagre.js'],
];

fs.mkdirSync('media/vendor', { recursive: true });
for (const [src, dst] of pairs) {
  if (!fs.existsSync(src)) {
    console.error(`MISSING: ${src}`);
    process.exit(1);
  }
  fs.copyFileSync(src, dst);
  console.log(`${src} -> ${dst} (${fs.statSync(dst).size} bytes)`);
}
