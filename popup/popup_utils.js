// File: popup/popup_utils.js
console.log("[Popup Utils] Module loading...");

// --- Constants ---
const IS_DEBUG = true; // Set to false to reduce console noise
const LOG_PREFIX = "[Popup]";
const CHECKBOX_DEBOUNCE_DELAY = 250; // ms delay for debouncing

// --- Logging Helper ---
/**
 * Logs messages with a prefix, respecting the IS_DEBUG flag for non-error messages.
 * @param {string} level - 'log', 'warn', 'error', 'info'
 * @param {string} message - The message to log.
 * @param {...any} args - Additional arguments to log.
 */
function log(level, message, ...args) {
    if (level === 'error' || level === 'warn' || IS_DEBUG) {
        const fn = console[level] || console.log;
        fn(`${LOG_PREFIX} ${message}`, ...args);
    }
}

// --- Formatting Helper ---
/**
 * Formats bytes into a human-readable string (B, KB, MB, GB).
 * @param {number | null | undefined} bytes The number of bytes.
 * @param {number} [decimals=2] The number of decimal places.
 * @returns {string} Formatted string.
 */
function formatBytes(bytes, decimals = 2) {
    if (bytes == null || bytes <= 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const index = Math.max(0, Math.min(i, sizes.length - 1));
    return parseFloat((bytes / Math.pow(k, index)).toFixed(dm)) + ' ' + sizes[index];
}

// --- Path Helpers ---
/**
 * Gets the canonical key for an item used in selectionState. Folders end with '/'.
 * @param {{path: string, type: 'blob' | 'tree'}} item - The file tree item.
 * @returns {string} The path key.
 */
function getItemPathKey(item) {
    if (!item || typeof item.path !== 'string' || typeof item.type !== 'string') {
        log('warn', 'getItemPathKey called with invalid item:', item);
        return ''; // Return empty string or handle error appropriately
    }
    return item.type === 'tree' ? `${item.path}/` : item.path;
}


/**
 * Finds all descendant paths (files and folders) for a given folder path key
 * within a provided flat list of file tree items.
 * @param {string} folderPathKey - The path key of the folder (e.g., "src/utils/"). Must end with '/'.
 * @param {Array<object>} fileTreeData - The flat array of file tree items { path, type, ... }.
 * @returns {string[]} - An array of full path keys for all descendants.
 */
function getDescendantPaths(folderPathKey, fileTreeData) {
    if (!folderPathKey || !folderPathKey.endsWith('/')) {
        log('warn', "getDescendantPaths called with non-folder path key:", folderPathKey);
        return [];
    }
     if (!Array.isArray(fileTreeData)) {
         log('warn', "getDescendantPaths called without valid fileTreeData array.");
         return [];
     }
    const descendants = [];
    const folderBasePath = folderPathKey.slice(0, -1);
    // Handle root folder comparison correctly (prefix is empty string)
    const pathPrefix = folderBasePath ? folderBasePath + '/' : '';

    for (const item of fileTreeData) {
        // Check if item.path starts with the folder's path prefix AND is not the folder itself.
        // Also handle root level items correctly (when pathPrefix is '').
        if (item && item.path && item.path.startsWith(pathPrefix) && (pathPrefix === '' || item.path !== folderBasePath)) {
             const key = getItemPathKey(item); // Use helper to ensure consistency
             if (key) descendants.push(key);
        }
    }
    // log('log', `Descendants for ${folderPathKey}:`, descendants);
    return descendants;
}

/**
 * Finds the parent folder path key for a given path key.
 * @param {string} itemPathKey - The path key of the file or folder.
 * @returns {string | null} - The parent folder path key ending with '/', or null if it's a root item.
 */
function getParentFolderPath(itemPathKey) {
     if (!itemPathKey || typeof itemPathKey !== 'string') {
         log('warn', 'getParentFolderPath called with invalid itemPathKey:', itemPathKey);
         return null;
     }
    const path = itemPathKey.endsWith('/') ? itemPathKey.slice(0, -1) : itemPathKey;
    const lastSlashIndex = path.lastIndexOf('/');

    if (lastSlashIndex === -1) {
        return null; // Root level item
    }
    return path.substring(0, lastSlashIndex) + '/';
}


// --- Debounce Helper ---
let debounceTimer = null;

/**
 * Debounces a function call.
 * @param {Function} func - The function to debounce.
 * @param {number} delay - The debounce delay in milliseconds.
 */
function debounce(func, delay) {
    clearTimeout(debounceTimer);
    log('log', `Debounce requested. Delay: ${delay}ms`);
    debounceTimer = setTimeout(async () => {
        log('log', `Debounce executing function.`);
        try {
             await func(); // Execute the function passed in
             log('log', `Debounced function executed successfully.`);
        } catch (error) {
             log('error', 'Error executing debounced function:', error);
             // Optionally handle/report the error further
        }
    }, delay);
}

export {
    log,
    formatBytes,
    getItemPathKey,
    getDescendantPaths,
    getParentFolderPath,
    debounce,
    CHECKBOX_DEBOUNCE_DELAY
};

console.log("[Popup Utils] Module loaded.");