const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../src/mcp');
const distDir = path.join(__dirname, '../dist/mcp');

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

const APP_FILES = ['view.html', 'view.css', 'view.js', 'view_chat.js', 'view_graph.js'];
for (const file of APP_FILES) {
  fs.copyFileSync(path.join(srcDir, file), path.join(distDir, file));
  console.log(`✓ Copied ${file} to dist/mcp/`);
}

// Vendored graph libraries (three.js, 3d-force-graph, force-graph) — committed, not fetched from
// a CDN, so the view app works with no internet connection.
const vendorSrcDir = path.join(srcDir, 'vendor');
const vendorDistDir = path.join(distDir, 'vendor');
if (!fs.existsSync(vendorDistDir)) {
  fs.mkdirSync(vendorDistDir, { recursive: true });
}
for (const file of fs.readdirSync(vendorSrcDir)) {
  const srcPath = path.join(vendorSrcDir, file);
  if (fs.statSync(srcPath).isDirectory()) continue; // handled below (model/)
  fs.copyFileSync(srcPath, path.join(vendorDistDir, file));
  console.log(`✓ Copied vendor/${file} to dist/mcp/vendor/`);
}

// Vendored embedding model (all-MiniLM-L6-v2, int8 ONNX) — same offline-first reasoning as the
// graph libraries above: committed to the repo, not downloaded at install/run time.
const modelSrcDir = path.join(vendorSrcDir, 'model');
const modelDistDir = path.join(vendorDistDir, 'model');
if (fs.existsSync(modelSrcDir)) {
  if (!fs.existsSync(modelDistDir)) {
    fs.mkdirSync(modelDistDir, { recursive: true });
  }
  for (const file of fs.readdirSync(modelSrcDir)) {
    fs.copyFileSync(path.join(modelSrcDir, file), path.join(modelDistDir, file));
    console.log(`✓ Copied vendor/model/${file} to dist/mcp/vendor/model/`);
  }
}
