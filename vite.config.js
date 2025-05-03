import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        background: resolve(__dirname, 'src/background.js'),
        offscreen: resolve(__dirname, 'public/offscreen.js')
      },
      output: {
        entryFileNames: (chunkInfo) => {
          return chunkInfo.name === 'background' || chunkInfo.name === 'offscreen' 
            ? '[name].js' 
            : 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      }
    },
    outDir: 'dist', // Ensure output directory is 'dist'
    emptyOutDir: true, // Clean the dist folder before build
    // Don't use ES modules in extension output as they can cause issues
    target: ['chrome89'],
    minify: false, // Disable minification for easier debugging
  },
  // Ensure public files like manifest.json are copied
  publicDir: 'public',
  define: {
    'process.env.NODE_ENV': '"production"'
  }
});
