import { defineConfig } from 'vite';

/** Builds the embeddable <katalyst-preview> web component to dist/widget/katalyst-widget.js (run after the app build). */
export default defineConfig({
  publicDir: false,
  build: {
    target: 'es2022',
    emptyOutDir: false,
    outDir: 'dist/widget',
    lib: { entry: 'src/widget/index.ts', formats: ['es'], fileName: () => 'katalyst-widget.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
