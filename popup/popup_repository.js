// File: popup/popup_repository.js
import { log, formatBytes } from './popup_utils.js';
import { parseRepoUrl, getRepoTree } from '../common/github_api.js';
import * as ui from './popup_ui.js';
import { getItemPathKey, getParentFolderPath } from './popup_utils.js';

console.log("[Popup Repository] Module loading...");

// --- Repository State ---
let currentRepoUrl = null;
let currentOwner = null;
let currentRepo = null;
let currentRef = null; // NEW: Store the detected ref (branch, tag, sha) or null for default
let actualRefUsed = null; // NEW: Store the ref actually used by getRepoTree (might be default)
let fileTreeData = [];
let isTruncated = false;
let calculatedFolderSizes = {};

// --- Private Helper Functions ---

/**
 * Calculates the total size of each folder recursively.
 * @param {Array<object>} flatTreeData - The array of file/folder items.
 * @returns {object} Map of { folderPathKey: size }
 */
function calculateAllFolderSizes(flatTreeData) {
    // console.log('[Popup Repository] Starting calculation of all folder sizes...'); // Reduced logging
    const startTime = performance.now();
    const fileSizes = {};
    const folderChildren = {};
    const allItemKeys = new Set();

    for (const item of flatTreeData) {
        if (!item || !item.path || !item.type) continue;
        const itemKey = getItemPathKey(item);
        allItemKeys.add(itemKey);

        if (item.type === 'blob' && typeof item.size === 'number') {
            fileSizes[itemKey] = item.size;
        } else if (item.type === 'tree') {
            if (!folderChildren[itemKey]) folderChildren[itemKey] = [];
        }

        const parentKey = getParentFolderPath(itemKey);
        if (parentKey) {
            if (!folderChildren[parentKey]) folderChildren[parentKey] = [];
            folderChildren[parentKey].push(itemKey);
        } else if (parentKey === null && item.type === 'tree') {
             if (!folderChildren[itemKey]) folderChildren[itemKey] = [];
        }
    }

    const memo = {};

    function getSize(pathKey) {
        if (memo[pathKey] !== undefined) return memo[pathKey];
        if (fileSizes[pathKey] !== undefined) {
            memo[pathKey] = fileSizes[pathKey];
            return fileSizes[pathKey];
        }
        if (folderChildren[pathKey]) {
            let totalSize = 0;
            for (const childKey of folderChildren[pathKey]) {
                 if (allItemKeys.has(childKey)) {
                    totalSize += getSize(childKey);
                 } else {
                     // log('warn', `[Popup Repository] Skipping size calculation for unknown child key: ${childKey} (parent: ${pathKey})`); // Reduced logging
                 }
            }
            memo[pathKey] = totalSize;
            return totalSize;
        }
        // log('warn', `[Popup Repository] Could not determine size for key: ${pathKey}`); // Reduced logging
        memo[pathKey] = 0;
        return 0;
    }

    const finalFolderSizes = {};
    for (const folderKey in folderChildren) {
         if (folderKey.endsWith('/')) {
            finalFolderSizes[folderKey] = getSize(folderKey);
         }
    }

    const endTime = performance.now();
    log('info', `[Popup Repository] Folder size calculation complete in ${((endTime - startTime)).toFixed(1)}ms. Found sizes for ${Object.keys(finalFolderSizes).length} folders.`);

    return finalFolderSizes;
}


// --- Public API ---

/** Initializes the repository module. */
function initRepository() {
    log('info', "[Popup Repository] Initializing repository module...");
    resetRepositoryState();
    log('info', "[Popup Repository] Repository module initialized");
    return {
        fileTreeData,
        getRepoInfo,
        getFolderSizes,
        getFileTreeData // Added for clarity, though already accessible via fileTreeData ref
    };
}

/** Resets all repository state variables. */
function resetRepositoryState() {
    log('info', '[Popup Repository] Resetting repository state');
    currentRepoUrl = null;
    currentOwner = null;
    currentRepo = null;
    currentRef = null; // NEW: Reset ref
    actualRefUsed = null; // NEW: Reset actual ref used
    fileTreeData.length = 0;
    isTruncated = false;
    calculatedFolderSizes = {};
}

/** Checks if the URL is from a GitHub domain. */
function isGitHubUrl(url) {
    try {
        const urlObj = new URL(url);
        // Looser check for enterprise github instances (e.g. github.mycompany.com)
        return urlObj.hostname === 'github.com' || urlObj.hostname.includes('github.');
    } catch (error) {
        return false;
    }
}


/**
 * Detects the current repository from the active tab URL.
 * Updates UI with Repo Name and Branch.
 * @returns {Promise<object | null>} Repository info object { url, owner, repo, ref } or null.
 */
async function detectRepository() {
    log('info', "[Popup Repository] Detecting repository from active tab...");
    ui.updateRepoTitle("Detecting...", "Attempting to detect repository from URL");
    ui.updateRepoBranch(null); // Clear branch initially

    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tabs || tabs.length === 0 || !tabs[0].url) {
            log('warn', "[Popup Repository] Could not access the current tab URL immediately.");
            currentRepoUrl = null;
             // Show specific error if URL couldn't be obtained
             ui.showFriendlyError("Cannot Access Tab", "Could not read the URL of the current tab.");
             throw new Error("no_tab_url"); // Specific error
        }

        currentRepoUrl = tabs[0].url;
        log('info', `[Popup Repository] Current URL: ${currentRepoUrl}`);

        if (!isGitHubUrl(currentRepoUrl)) {
            log('info', "[Popup Repository] Not on a GitHub site. URL:", currentRepoUrl);
            ui.showFriendlyError(
                "Requires GitHub Page",
                "Please navigate to a GitHub repository page and refresh."
            );
            throw new Error("not_github");
        }

        // Use the updated parseRepoUrl to get owner, repo, and ref
        const repoInfo = parseRepoUrl(currentRepoUrl);

        if (!repoInfo || !repoInfo.owner || !repoInfo.repo) {
            log('info', "[Popup Repository] Not on a GitHub repository page or URL malformed. URL:", currentRepoUrl);
            ui.showFriendlyError(
                 "Repository Not Found",
                 "Navigate to a repository's main page or code tab and refresh."
             );
             throw new Error("not_repo");
        }

        currentOwner = repoInfo.owner;
        currentRepo = repoInfo.repo;
        currentRef = repoInfo.ref; // Store the detected ref (can be null)

        log('info', `[Popup Repository] Detected repository: ${currentOwner}/${currentRepo}, Ref in URL: ${currentRef || 'None (implies default)'}`);

        // Update UI with detected info
        ui.updateRepoTitle(`${currentOwner}/${currentRepo}`, `Repository: ${currentOwner}/${currentRepo}`);
        // Update branch display - pass null if ref wasn't in URL, ui fn will handle 'default' text
        ui.updateRepoBranch(currentRef);

        return {
            url: currentRepoUrl,
            owner: currentOwner,
            repo: currentRepo,
            ref: currentRef // Return the ref detected from URL
        };

    } catch (error) {
         // Re-throw specific known errors for coordinator
         if (error.message === "not_github" || error.message === "not_repo" || error.message === "no_tab_url") {
             throw error;
         }

         // Handle unexpected errors
         log('error', "[Popup Repository] Unexpected error during repository detection:", error);
         ui.showError(`Repository detection failed: ${error.message}`);
         ui.updateRepoTitle("Detection Error");
         ui.updateRepoBranch(null); // Clear branch on error
         resetRepositoryState(); // Reset internal state
         return null;
    }
}

/**
 * Fetches the repository file tree data using the detected owner, repo, and ref.
 * Calculates folder sizes. Updates UI with the actual ref used.
 * @returns {Promise<boolean>} True if data fetch and processing was successful, false otherwise.
 */
async function fetchRepositoryData() {
    // Ensure owner/repo were detected successfully first
    if (!currentOwner || !currentRepo) {
         log('error', "[Popup Repository] Cannot fetch data: Owner or repo not detected.");
         // UI error likely shown by detectRepository already
         return false;
    }
    log('info', `[Popup Repository] Fetching repository data for ${currentOwner}/${currentRepo} (Ref: ${currentRef || 'default'})`);

    // Update status with the intended ref
    const fetchStatusRef = currentRef ? `ref ${currentRef}` : 'default branch';
    ui.showStatus(`Fetching file tree for ${currentOwner}/${currentRepo} (${fetchStatusRef})...`);

    try {
        // Pass the detected ref (which might be null) to getRepoTree
        const repoTreeResult = await getRepoTree(currentOwner, currentRepo, currentRef);

        const validTreeData = repoTreeResult.tree.filter(item =>
            item && item.path && (item.type === 'blob' || item.type === 'tree')
        );

        // Update module state
        fileTreeData.length = 0;
        fileTreeData.push(...validTreeData);
        isTruncated = repoTreeResult.truncated;
        actualRefUsed = repoTreeResult.ref; // Store the ref API confirmed it used

        log('info', `[Popup Repository] Received ${fileTreeData.length} valid tree items. Truncated: ${isTruncated}. Actual Ref Used: ${actualRefUsed}`);

        // Update UI with the actual ref used (in case default was resolved)
        // Only update if it differs from what was initially displayed or if initial was null
        if (currentRef !== actualRefUsed) {
             log('info', `[Popup Repository] Updating UI branch display to actual ref used: ${actualRefUsed}`);
             ui.updateRepoBranch(actualRefUsed);
        }

        if (fileTreeData.length === 0 && !isTruncated) {
            ui.showStatus(`Repository tree for ref '${actualRefUsed}' appears to be empty or inaccessible.`, true);
        } else if (isTruncated) {
            ui.showStatus(`Warning: Repository tree for ref '${actualRefUsed}' is large and may be incomplete.`, true);
        } else {
            ui.clearMessages(); // Clear status only if no warning/empty message needed
        }

        // Calculate Folder Sizes
        ui.showStatus("Calculating folder sizes..."); // Show temporary status
        calculatedFolderSizes = calculateAllFolderSizes(fileTreeData);
        ui.clearMessages(); // Clear status after calculation

        return true;

    } catch (error) {
        log('error', `[Popup Repository] Failed to fetch or process repository data for ref '${currentRef || 'default'}':`, error);
        ui.showError(`Error loading data for ${fetchStatusRef}: ${error.message}. Check console.`);
        resetRepositoryState();
        ui.updateRepoTitle("Error Loading Data"); // Update title on fetch error
        ui.updateRepoBranch(null); // Clear branch display on fetch error
        return false;
    }
}

/** Gets current repository information including the ref used. */
function getRepoInfo() {
    return {
        url: currentRepoUrl,
        owner: currentOwner,
        repo: currentRepo,
        ref: actualRefUsed, // Return the ref confirmed by the API
        isTruncated
    };
}

/** Gets the file tree data array. */
function getFileTreeData() {
    return fileTreeData;
}

/** Gets the calculated folder sizes map. */
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
    getFolderSizes
};

console.log("[Popup Repository] Module loaded.");