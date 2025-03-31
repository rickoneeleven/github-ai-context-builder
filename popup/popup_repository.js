// File: popup/popup_repository.js
import { log, formatBytes } from './popup_utils.js'; // formatBytes might be useful for logging here
import { parseRepoUrl, getRepoTree } from '../common/github_api.js';
import * as ui from './popup_ui.js';
import { getItemPathKey, getParentFolderPath } from './popup_utils.js'; // Import path helpers

console.log("[Popup Repository] Module loading...");

// --- Repository State ---
let currentRepoUrl = null;
let currentOwner = null;
let currentRepo = null;
let fileTreeData = [];
let isTruncated = false;
let calculatedFolderSizes = {}; // NEW: Store calculated sizes { folderPathKey: size }

// --- Private Helper Functions ---

/**
 * Calculates the total size of each folder recursively based on the flat file tree data.
 * Uses memoization to avoid redundant calculations.
 * @param {Array<object>} flatTreeData - The array of file/folder items from GitHub API.
 * @returns {object} A map where keys are folder path keys (ending in '/') and values are their total sizes in bytes.
 */
function calculateAllFolderSizes(flatTreeData) {
    log('info', '[Popup Repository] Starting calculation of all folder sizes...');
    const startTime = performance.now();

    const fileSizes = {}; // Map: { filePathKey: size }
    const folderChildren = {}; // Map: { folderPathKey: [childPathKey1, ...] }
    const allItemKeys = new Set(); // Set of all valid path keys

    // Pass 1: Populate fileSizes, folderChildren map, and allItemKeys set
    for (const item of flatTreeData) {
        if (!item || !item.path || !item.type) continue; // Skip invalid items

        const itemKey = getItemPathKey(item);
        allItemKeys.add(itemKey);

        if (item.type === 'blob' && typeof item.size === 'number') {
            fileSizes[itemKey] = item.size;
        } else if (item.type === 'tree') {
            // Ensure folder entry exists even if empty
            if (!folderChildren[itemKey]) {
                folderChildren[itemKey] = [];
            }
        }

        // Map item to its parent
        const parentKey = getParentFolderPath(itemKey);
        if (parentKey) {
            if (!folderChildren[parentKey]) {
                folderChildren[parentKey] = [];
            }
            folderChildren[parentKey].push(itemKey);
        } else if (parentKey === null && item.type === 'tree') {
             // Ensure root folders are in folderChildren map
             if (!folderChildren[itemKey]) {
                folderChildren[itemKey] = [];
            }
        }
    }

    const memo = {}; // Memoization cache for calculated sizes { pathKey: size }

    /**
     * Recursively calculates the size of a given item (file or folder).
     * @param {string} pathKey - The path key of the item.
     * @returns {number} The total size in bytes.
     */
    function getSize(pathKey) {
        // Check memoization cache
        if (memo[pathKey] !== undefined) {
            return memo[pathKey];
        }

        // Base case: File size
        if (fileSizes[pathKey] !== undefined) {
            memo[pathKey] = fileSizes[pathKey];
            return fileSizes[pathKey];
        }

        // Recursive case: Folder size
        if (folderChildren[pathKey]) {
            let totalSize = 0;
            for (const childKey of folderChildren[pathKey]) {
                 // Ensure childKey is valid before recursing
                 if (allItemKeys.has(childKey)) {
                    totalSize += getSize(childKey); // Recursive call
                 } else {
                     log('warn', `[Popup Repository] Skipping size calculation for unknown child key: ${childKey} (parent: ${pathKey})`);
                 }
            }
            memo[pathKey] = totalSize;
            return totalSize;
        }

        // Should not happen for valid keys from the tree, but handle defensively
        log('warn', `[Popup Repository] Could not determine size for key (not file, not folder with children?): ${pathKey}`);
        memo[pathKey] = 0;
        return 0;
    }

    // Calculate size for all folders defined in folderChildren
    const finalFolderSizes = {};
    for (const folderKey in folderChildren) {
        // We only want to store sizes for actual folders (keys ending in '/')
         if (folderKey.endsWith('/')) {
            finalFolderSizes[folderKey] = getSize(folderKey);
         }
    }

    const endTime = performance.now();
    log('info', `[Popup Repository] Folder size calculation complete in ${((endTime - startTime)).toFixed(1)}ms. Found sizes for ${Object.keys(finalFolderSizes).length} folders.`);

    return finalFolderSizes;
}


// --- Public API ---

/**
 * Initializes the repository module.
 * @returns {object} Object containing references to repository data and getters.
 */
function initRepository() {
    log('info', "[Popup Repository] Initializing repository module...");

    // Reset state to start fresh
    resetRepositoryState();

    log('info', "[Popup Repository] Repository module initialized");
    return {
        fileTreeData, // Return reference to the file tree data array
        getRepoInfo, // Function to get current repo info
        getFolderSizes, // NEW: Function to get calculated folder sizes
    };
}

/**
 * Resets all repository state variables.
 */
function resetRepositoryState() {
    log('info', '[Popup Repository] Resetting repository state');
    currentRepoUrl = null;
    currentOwner = null;
    currentRepo = null;
    fileTreeData.length = 0; // Clear the array without changing reference
    isTruncated = false;
    calculatedFolderSizes = {}; // NEW: Reset calculated sizes
}

// isGitHubUrl function remains the same...
/**
 * Checks if the URL is from a GitHub domain
 * @param {string} url - The URL to check
 * @returns {boolean} - True if the URL is from a GitHub domain
 */
function isGitHubUrl(url) {
    try {
        const urlObj = new URL(url);
        // Check for github.com and any potential enterprise GitHub instances
        return urlObj.hostname === 'github.com' || urlObj.hostname.endsWith('.github.com');
    } catch (error) {
        return false; // Invalid URL
    }
}


// detectRepository function remains the same...
/**
 * Detects the current repository from the active tab URL.
 * @returns {Promise<object>} Repository information object or null if detection fails
 */
async function detectRepository() {
    log('info', "[Popup Repository] Detecting repository from active tab...");

    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tabs || tabs.length === 0 || !tabs[0].url) {
            // Allow initialization to proceed, but show error later if still no URL
            log('warn', "[Popup Repository] Could not access the current tab URL immediately.");
             currentRepoUrl = null; // Ensure it's null if detection fails here
             // Let the UI show 'Loading...' and potentially fail later in fetch if still no repo
             return null; // Indicate detection is incomplete/failed for now
        }

        currentRepoUrl = tabs[0].url;
        log('info', `[Popup Repository] Current URL: ${currentRepoUrl}`);

        // Check if we're on GitHub before trying to parse the repo URL
        if (!isGitHubUrl(currentRepoUrl)) {
            log('info', "[Popup Repository] Not on a GitHub site. URL:", currentRepoUrl);
            ui.updateRepoTitle("Not a GitHub Site");
            ui.showFriendlyError(
                "Extension requires a GitHub page",
                "Please navigate to a GitHub repository page and refresh the extension."
            );
            throw new Error("not_github"); // Throw specific error for coordinator
        }

        const repoInfo = parseRepoUrl(currentRepoUrl);

        if (!repoInfo) {
            log('info', "[Popup Repository] Not on a GitHub repository page. URL:", currentRepoUrl);
            ui.updateRepoTitle("Not a Repository Page");
             ui.showFriendlyError(
                 "Could not identify repository",
                 "Please navigate to the main page or code tab of a GitHub repository and refresh."
             );
             throw new Error("not_repo"); // Throw specific error for coordinator
        }

        currentOwner = repoInfo.owner;
        currentRepo = repoInfo.repo;

        log('info', `[Popup Repository] Detected repository: ${currentOwner}/${currentRepo}`);
        ui.updateRepoTitle(`${currentOwner}/${currentRepo}`);

        return {
            url: currentRepoUrl,
            owner: currentOwner,
            repo: currentRepo
        };

    } catch (error) {
         // Re-throw specific errors for coordinator, handle unexpected ones
         if (error.message === "not_github" || error.message === "not_repo") {
             throw error; // Let coordinator handle these known states
         }

         log('error', "[Popup Repository] Unexpected error during repository detection:", error);
         ui.updateRepoTitle("Detection Error");
         ui.showError(`Repository detection failed: ${error.message}`);
         return null; // Indicate failure
    }
}

/**
 * Fetches the repository file tree data from GitHub API and calculates folder sizes.
 * @returns {Promise<boolean>} True if data fetch and processing was successful, false otherwise
 */
async function fetchRepositoryData() {
    log('info', `[Popup Repository] Fetching repository data for ${currentOwner}/${currentRepo}`);

    ui.showStatus(`Fetching file tree for ${currentOwner}/${currentRepo}...`);

    try {
        // Validate we have owner and repo set
        if (!currentOwner || !currentRepo) {
            throw new Error("Repository owner or name is not set. Please refresh.");
        }

        // Fetch tree data from GitHub API
        const repoTreeResult = await getRepoTree(currentOwner, currentRepo);

        // Filter valid tree items immediately
        const validTreeData = repoTreeResult.tree.filter(item =>
            item && item.path && (item.type === 'blob' || item.type === 'tree')
        );

        // Update module state
        fileTreeData.length = 0; // Clear without changing reference
        fileTreeData.push(...validTreeData); // Add all valid items to existing array
        isTruncated = repoTreeResult.truncated;

        log('info', `[Popup Repository] Received ${fileTreeData.length} valid tree items. Truncated: ${isTruncated}`);

        if (fileTreeData.length === 0 && !isTruncated) {
            ui.showStatus("Repository appears to be empty or inaccessible.", true);
            // Don't return false yet, calculation step might still be valid (result is empty maps)
        }

        // Show truncation warning if needed
        if (isTruncated) {
            ui.showStatus("Warning: Repository tree is large and may be incomplete.", true);
        }

        // --- NEW: Calculate Folder Sizes ---
        ui.showStatus("Calculating folder sizes..."); // Update status
        calculatedFolderSizes = calculateAllFolderSizes(fileTreeData);
        // log('log', "[Popup Repository] Calculated Folder Sizes:", calculatedFolderSizes); // Debugging log

        ui.clearMessages(); // Clear status after calculation
        return true;

    } catch (error) {
        log('error', "[Popup Repository] Failed to fetch or process repository data:", error);
        ui.showError(`Error loading data: ${error.message}. Check console.`);
        resetRepositoryState(); // Reset state on failure
        return false;
    }
}

// getRepoInfo function remains the same...
/**
 * Gets current repository information.
 * @returns {object} Repository information object
 */
function getRepoInfo() {
    return {
        url: currentRepoUrl,
        owner: currentOwner,
        repo: currentRepo,
        isTruncated
    };
}

// getFileTreeData function remains the same...
/**
 * Gets the file tree data array.
 * @returns {Array} Array of file tree items
 */
function getFileTreeData() {
    return fileTreeData;
}

/**
 * NEW: Gets the calculated folder sizes map.
 * @returns {object} Map of { folderPathKey: size }
 */
function getFolderSizes() {
    return calculatedFolderSizes;
}

export {
    initRepository,
    resetRepositoryState,
    detectRepository,
    fetchRepositoryData,
    getRepoInfo,
    getFileTreeData,
    getFolderSizes // NEW export
};

console.log("[Popup Repository] Module loaded.");