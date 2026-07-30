import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { runHttpMcpServer, DEVSMIND_PORT } from '../mcp/server';

/**
 * Walk up from `startDir` until we find a `.devmind/config.json`,
 * or return null if not found.
 */
function findDevmindDir(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, '.devmind');
    if (fs.existsSync(path.join(candidate, 'config.json'))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return null; // filesystem root
    current = parent;
  }
}

export async function handleView(opts: { path?: string; port: string }) {
  const cwd = process.cwd();
  let devmindDir: string | null;

  if (opts.path) {
    const resolved = path.resolve(opts.path);
    devmindDir = fs.existsSync(path.join(resolved, 'config.json')) ? resolved : null;
  } else {
    devmindDir = findDevmindDir(cwd);
  }

  if (!devmindDir) {
    console.error(
      `❌ No .devmind directory found.\n` +
      `   Run from inside a DevsMind brain folder, or pass --path <devmind_path>.`
    );
    process.exit(1);
  }

  const port = parseInt(opts.port, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`❌ Invalid port: ${opts.port}`);
    process.exit(1);
  }

  console.log(`🧠 Starting DevsMind Graph Visualizer server on port ${port}...`);

  try {
    // Start Express server (resolves once server is listening), bound to the project we just
    // resolved so its MCP endpoint serves this one brain and callers never pass a devmind_path.
    await runHttpMcpServer(port, devmindDir);

    // Open default browser
    const url = `http://localhost:${port}/?path=${encodeURIComponent(devmindDir)}`;
    console.log(`🌐 Opening visualizer in your browser: ${url}`);

    const openCmd = process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;

    exec(openCmd, (err) => {
      if (err) {
        console.log(`💡 Click or copy this link if it didn't open automatically: ${url}`);
      }
    });

  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).message;
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`❌ Port ${port} is already in use. Try starting with a different port: devsmind view --port <other>`);
    } else {
      console.error(`❌ Visualizer failed to start: ${msg}`);
    }
    process.exit(1);
  }
}
