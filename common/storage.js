console.log("[Storage] Storage module loading...");

/**
 * Retrieves the GitHub PAT from local storage.
 * @returns {Promise<string | null>} Resolves with the PAT string or null if not set or error.
 */
async function getGitHubPat() {
    console.log("[Storage] Attempting to get GitHub PAT.");
    try {
        const result = await chrome.storage.local.get('githubPat');
        // Check for runtime errors after the promise resolves
        if (chrome.runtime.lastError) {
            console.error("[Storage] Error getting GitHub PAT:", chrome.runtime.lastError.message);
            return null; // Return null on error
        }
        const pat = result.githubPat;
        if (pat) {
            console.log("[Storage] GitHub PAT retrieved successfully.");
            return pat;
        } else {
            console.log("[Storage] No GitHub PAT found in storage.");
            return null;
        }
    } catch (error) {
        console.error("[Storage] Exception while getting GitHub PAT:", error);
        return null; // Return null on exception
    }
}

/**
 * Saves the GitHub PAT to local storage.
 * @param {string} pat The GitHub PAT string to save. An empty string clears the PAT.
 * @returns {Promise<boolean>} Resolves with true if successful, false otherwise.
 */
async function setGitHubPat(pat) {
    console.log("[Storage] Attempting to set GitHub PAT.");
    if (typeof pat !== 'string') {
        console.error("[Storage] Invalid PAT type provided:", typeof pat);
        return false;
    }
    try {
        await chrome.storage.local.set({ githubPat: pat });
        // Check for runtime errors after the promise resolves
        if (chrome.runtime.lastError) {
            console.error("[Storage] Error setting GitHub PAT:", chrome.runtime.lastError.message);
            return false;
        }
        console.log("[Storage] GitHub PAT set successfully.");
        return true;
    } catch (error) {
        console.error("[Storage] Exception while setting GitHub PAT:", error);
        return false;
    }
}

/**
 * Creates a unique storage key for a repository's selection state based on its URL.
 * Strips protocol, trailing slashes, and fragments/query params for consistency.
 * @param {string} repoUrl The full URL of the GitHub repository page.
 * @returns {string | null} A consistent key for storage, or null if URL is invalid.
 */
function getRepoStorageKey(repoUrl) {
    try {
        const url = new URL(repoUrl);
        if (url.hostname !== 'github.com') {
            console.warn("[Storage] Non-GitHub URL provided for key generation:", repoUrl);
            // Allow it for now, maybe useful for GH Enterprise? Revisit if needed.
            // return null;
        }
        // Normalize: lowercase hostname, remove leading/trailing slashes from pathname
        const path = url.pathname.replace(/^\/|\/$/g, '');
        const key = `selectionState_${url.hostname}_${path}`;
        console.log(`[Storage] Generated storage key for ${repoUrl}: ${key}`);
        return key;
    } catch (error) {
        console.error("[Storage] Invalid URL provided for key generation:", repoUrl, error);
        return null;
    }
}

/**
 * Retrieves the saved selection state for a given repository URL.
 * @param {string} repoUrl The URL of the repository.
 * @returns {Promise<object | null>} Resolves with the selection state object or null if not found or error.
 */
async function getRepoSelectionState(repoUrl) {
    const storageKey = getRepoStorageKey(repoUrl);
    if (!storageKey) {
        return null; // Error handled in getRepoStorageKey
    }
    console.log(`[Storage] Attempting to get selection state for key: ${storageKey}`);
    try {
        const result = await chrome.storage.local.get(storageKey);
        if (chrome.runtime.lastError) {
            console.error(`[Storage] Error getting selection state for key ${storageKey}:`, chrome.runtime.lastError.message);
            return null;
        }
        const state = result[storageKey];
        if (state && typeof state === 'object') {
            console.log(`[Storage] Selection state retrieved successfully for key: ${storageKey}`);
            return state;
        } else {
            console.log(`[Storage] No selection state found for key: ${storageKey}`);
            return null;
        }
    } catch (error) {
        console.error(`[Storage] Exception while getting selection state for key ${storageKey}:`, error);
        return null;
    }
}

/**
 * Saves the selection state for a given repository URL.
 * @param {string} repoUrl The URL of the repository.
 * @param {object} selectionState The selection state object to save (e.g., { 'path/to/file.js': true, 'path/to/folder/': false }).
 * @returns {Promise<boolean>} Resolves with true if successful, false otherwise.
 */
async function setRepoSelectionState(repoUrl, selectionState) {
    const storageKey = getRepoStorageKey(repoUrl);
    if (!storageKey) {
        return false; // Error handled in getRepoStorageKey
    }
    if (typeof selectionState !== 'object' || selectionState === null) {
        console.error("[Storage] Invalid selection state provided:", selectionState);
        return false;
    }
    console.log(`[Storage] Attempting to set selection state for key: ${storageKey}`);
    try {
        await chrome.storage.local.set({ [storageKey]: selectionState });
        if (chrome.runtime.lastError) {
            console.error(`[Storage] Error setting selection state for key ${storageKey}:`, chrome.runtime.lastError.message);
            return false;
        }
        console.log(`[Storage] Selection state set successfully for key: ${storageKey}`);
        return true;
    } catch (error) {
        console.error(`[Storage] Exception while setting selection state for key ${storageKey}:`, error);
        return false;
    }
}


// Note: To use these functions in other scripts (like options.js or popup.js),
// you'll need to make sure this script is loaded correctly.
// In Manifest V3, direct import/export isn't straightforward between all script types.
// For popup/options -> common, use `<script type="module">` and `import`.
// For service worker (if we add one later) -> common, use `importScripts()`.
// For content script -> common, bundling or careful script injection is needed.
// We'll manage this as we build the importing scripts.

console.log("[Storage] Storage module loaded.");

// Since this isn't a module exporting directly for simple script tags,
// we might attach functions to a global object or handle imports in the consuming scripts.
// For now, assuming module usage in popup/options.
export {
    getGitHubPat,
    setGitHubPat,
    getRepoSelectionState,
    setRepoSelectionState
};