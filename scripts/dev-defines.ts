// Preloaded by `bun run dev` to stand in for the compile-time constants that
// tsup injects via `define` (see tsup.config.ts) when running src/ unbuilt.
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
);

Object.assign(globalThis, {
  __VERSION__: `${packageJson.version}-dev`,
  __HOMEPAGE__: packageJson.homepage ?? '',
});
