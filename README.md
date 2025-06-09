# GitHub AI Context Builder 


This Chrome extension allows users to select files from a GitHub repository and copy their combined content to the clipboard, formatted for use as context with AI models. It uses the GitHub API to fetch repository file trees and content.

## Development Setup

To develop or modify this extension, you need Node.js and npm installed.

1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/rickoneeleven/github-ai-context-builder.git
    cd github-ai-context-builder
    ```

2.  **Install Dependencies:**
    This project uses npm to manage dependencies, including Rollup (for bundling JavaScript modules) and gpt-tokenizer (for accurate token counting). Install them by running:
    ```bash
    npm install
    ```
    This will download all necessary packages into the `node_modules` directory based on the `package.json` and `package-lock.json` files.

## Running for Development

Because the extension uses JavaScript modules and external libraries (like `gpt-tokenizer`), the source code needs to be bundled into files that the Chrome browser can load directly. This project uses Rollup for bundling.

**You MUST run a build process after making changes to JavaScript files in the `popup/`, `options/`, or `common/` directories.**

There are two ways to do this:

1.  **Automatic Rebuild (Recommended):**
    Open your terminal in the project root directory and run:
    ```bash
    npm run watch
    ```
    This command starts Rollup in watch mode. It will monitor your source files (`popup/**`, `options/**`, `common/**`). When you save a change to one of these files, Rollup will automatically rebuild the necessary bundled output file(s) in the `dist/` directory (`dist/popup_bundle.js`, `dist/options_bundle.js`).

    **After `npm run watch` rebuilds, you still need to reload the extension in Chrome (`chrome://extensions`) to see your changes reflected.**

2.  **Manual Build:**
    If you prefer not to have the watch process running, you can manually build the bundles anytime you make changes by running:
    ```bash
    npm run build
    ```
    This performs a one-time build, updating the files in the `dist/` directory. Remember to run this *before* reloading the extension in Chrome.

## Loading the Extension in Chrome

1.  Open Chrome and navigate to `chrome://extensions`.
2.  Enable "Developer mode" using the toggle switch in the top-right corner.
3.  Click the "Load unpacked" button.
4.  Select the root directory of this project (`github-ai-context-builder`).
5.  The extension should now be loaded and active. Remember to click the reload icon for the extension on the `chrome://extensions` page after running `npm run build` or after `npm run watch` has finished rebuilding following your code changes.