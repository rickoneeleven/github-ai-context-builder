// rollup.config.js
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

// Determine if we are in production mode (e.g., for building the final zip)
// We aren't using this yet, but it's good practice to include.
// const isProduction = process.env.NODE_ENV === 'production';

export default [
  // Configuration for the popup script
  {
    input: 'popup/popup.js', // Entry point for the popup
    output: {
      file: 'dist/popup_bundle.js', // Where to output the bundled file
      format: 'esm', // ES Module format, suitable for <script type="module">
      sourcemap: 'inline', // Include source maps for easier debugging (remove 'inline' for production)
    },
    plugins: [
      resolve(), // Finds modules in node_modules
      commonjs() // Converts CommonJS modules to ES Modules
    ],
    watch: {
        // Optional: Helps during development by automatically rebuilding
        // You can remove this section if you prefer manual builds
        include: ['popup/**', 'common/**'], // Watch these folders
        exclude: 'node_modules/**'
    }
  },
  // Configuration for the options script
  {
    input: 'options/options.js', // Entry point for the options page
    output: {
      file: 'dist/options_bundle.js', // Where to output the bundled file
      format: 'esm',
      sourcemap: 'inline',
    },
    plugins: [
      resolve(),
      commonjs()
    ],
    watch: {
        include: ['options/**', 'common/**'],
        exclude: 'node_modules/**'
    }
  },
  // Configuration for the background script
  {
    input: 'background.js', // Entry point for the background service worker
    output: {
      file: 'dist/background_bundle.js', // Where to output the bundled file
      format: 'esm', // ES Module format for service worker
      sourcemap: 'inline',
    },
    plugins: [
      resolve(),
      commonjs()
    ],
    watch: {
        include: ['background.js', 'common/**'],
        exclude: 'node_modules/**'
    }
  }
];