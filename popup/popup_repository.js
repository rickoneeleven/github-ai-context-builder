// File: popup/popup_repository.js
import { log, formatBytes } from './popup_utils.js';
// Import specific functions and the custom error type
import { parseRepoUrl, getRepoTree, ApiAuthError } from '../common/github_api.js';
import * as ui from './popup_ui.js';
import { getItemPathKey, getParentFolderPath } from './popup_utils.js';

console.log("[Popup Repository] Module loading...");

// --- Repository State ---
let currentRepoUrl = null;
let currentOwner = null;
let currentRepo = null;
let currentRef = null;
let actualRefUsed = null;
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
    // console.log('[Popup Repository] Starting calculation of all folder sizes...');
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
                 }
            }
            memo[pathKey] = totalSize;
            return totalSize;
        }
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
    // Reduced logging for performance
    // log('info', `[Popup Repository] Folder size calculation complete in ${((endTime - startTime)).toFixed(1)}ms. Found sizes for ${Object.keys(finalFolderSizes).length} folders.`);

    return finalFolderSizes;
}


// --- Public API ---

/** Initializes the repository module. */
function initRepository() {
    // log('info', "[Popup Repository] Initializing repository module..."); // Reduced noise
    resetRepositoryState();
    // log('info', "[Popup Repository] Repository module initialized"); // Reduced noise
    return {
        fileTreeData,
        getRepoInfo,
        getFolderSizes,
        getFileTreeData
    };
}

/** Resets all repository state variables. */
function resetRepositoryState() {
    // log('info', '[Popup Repository] Resetting repository state'); // Reduced noise
    currentRepoUrl = null;
    currentOwner = null;
    currentRepo = null;
    currentRef = null;
    actualRefUsed = null;
    fileTreeData.length = 0;
    isTruncated = false;
    calculatedFolderSizes = {};
}

/** Checks if the URL is from a GitHub domain. */
function isGitHubUrl(url) {
    try {
        const urlObj = new URL(url);
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
    // log('info', "[Popup Repository] Detecting repository from active tab..."); // Reduced noise
    ui.updateRepoTitle("Detecting...", "Attempting to detect repository from URL");
    ui.updateRepoBranch(null);

    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tabs || tabs.length === 0 || !tabs[0].url) {
            log('warn', "[Popup Repository] Could not access the current tab URL immediately.");
            currentRepoUrl = null;
             ui.showFriendlyError("Cannot Access Tab", "Could not read the URL of the current tab.");
             throw new Error("no_tab_url");
        }

        currentRepoUrl = tabs[0].url;
        // log('info', `[Popup Repository] Current URL: ${currentRepoUrl}`); // Reduced noise

        if (!isGitHubUrl(currentRepoUrl)) {
            // log('info', "[Popup Repository] Not on a GitHub site. URL:", currentRepoUrl); // Reduced noise
            ui.showFriendlyError(
                "Requires GitHub Page",
                "Please navigate to a GitHub repository page and refresh."
            );
            throw new Error("not_github");
        }

        const repoInfo = parseRepoUrl(currentRepoUrl);

        if (!repoInfo || !repoInfo.owner || !repoInfo.repo) {
            // log('info', "[Popup Repository] Not on a GitHub repository page or URL malformed. URL:", currentRepoUrl); // Reduced noise
            ui.showFriendlyError(
                 "Repository Not Found",
                 "Navigate to a repository's main page or code tab and refresh."
             );
             throw new Error("not_repo");
        }

        currentOwner = repoInfo.owner;
        currentRepo = repoInfo.repo;
        currentRef = repoInfo.ref;

        // log('info', `[Popup Repository] Detected repository: ${currentOwner}/${currentRepo}, Ref in URL: ${currentRef || 'None (implies default)'}`); // Reduced noise

        ui.updateRepoTitle(`${currentOwner}/${currentRepo}`, `Repository: ${currentOwner}/${currentRepo}`);
        ui.updateRepoBranch(currentRef);

        return {
            url: currentRepoUrl,
            owner: currentOwner,
            repo: currentRepo,
            ref: currentRef
        };

    } catch (error) {
         if (error.message === "not_github" || error.message === "not_repo" || error.message === "no_tab_url") {
             throw error; // Re-throw known errors for coordinator
         }
         // Handle unexpected errors
         log('error', "[Popup Repository] Unexpected error during repository detection:", error); // Keep this error log
         ui.showError(`Repository detection failed: ${error.message}`);
         ui.updateRepoTitle("Detection Error");
         ui.updateRepoBranch(null);
         resetRepositoryState();
         return null;
    }
}

/**
 * Fetches the repository file tree data using the detected owner, repo, and ref.
 * Calculates folder sizes. Updates UI with the actual ref used.
 * @returns {Promise<boolean>} True if data fetch and processing was successful, false otherwise.
 */
async function fetchRepositoryData() {
    if (!currentOwner || !currentRepo) {
         // This log should ideally not happen if detectRepository works, but keep as error just in case
         log('error', "[Popup Repository] Cannot fetch data: Owner or repo not detected.");
         return false;
    }
    // log('info', `[Popup Repository] Fetching repository data for ${currentOwner}/${currentRepo} (Ref: ${currentRef || 'default'})`); // Reduced noise

    const fetchStatusRef = currentRef ? `ref ${currentRef}` : 'default branch';
    ui.showStatus(`Fetching file tree for ${currentOwner}/${currentRepo} (${fetchStatusRef})...`);

    try {
        const repoTreeResult = await getRepoTree(currentOwner, currentRepo, currentRef);

        const validTreeData = repoTreeResult.tree.filter(item =>
            item && item.path && (item.type === 'blob' || item.type === 'tree')
        );

        fileTreeData.length = 0;
        fileTreeData.push(...validTreeData);
        isTruncated = repoTreeResult.truncated;
        actualRefUsed = repoTreeResult.ref;

        // log('info', `[Popup Repository] Received ${fileTreeData.length} valid tree items. Truncated: ${isTruncated}. Actual Ref Used: ${actualRefUsed}`); // Reduced noise

        if (currentRef !== actualRefUsed) {
             // log('info', `[Popup Repository] Updating UI branch display to actual ref used: ${actualRefUsed}`); // Reduced noise
             ui.updateRepoBranch(actualRefUsed);
        }

        if (fileTreeData.length === 0 && !isTruncated) {
            ui.showStatus(`Repository tree for ref '${actualRefUsed}' appears to be empty or inaccessible.`, true);
        } else if (isTruncated) {
            ui.showStatus(`Warning: Repository tree for ref '${actualRefUsed}' is large and may be incomplete.`, true);
        } else {
            ui.clearMessages();
        }

        ui.showStatus("Calculating folder sizes...");
        calculatedFolderSizes = calculateAllFolderSizes(fileTreeData);
        ui.clearMessages();

        return true;

    } catch (error) {
        // --- MODIFIED CATCH BLOCK ---
        if (error instanceof ApiAuthError) {
            // Log handled auth error with 'info' level for regular console, not 'error'
            log('info', `[Popup Repository] Handled ApiAuthError fetching data for ref '${currentRef || 'default'}':`, error.message);
            // If it's the specific 404/Auth error, show the friendly message
            ui.showFriendlyError(
                "Private Repository Access Denied",
                "Could not fetch data. This might be a private repository. Please ensure a valid GitHub Personal Access Token (PAT) with 'repo' scope is added in the extension options."
            );
            ui.updateRepoTitle("Access Denied"); // Update title appropriately
        } else {
            // For all other *unexpected* errors, log with 'error' and show generic message
            log('error', `[Popup Repository] Failed to fetch or process repository data for ref '${currentRef || 'default'}':`, error); // LOG UNEXPECTED ERRORS HERE
            ui.showError(`Error loading data for ${fetchStatusRef}: ${error.message}. Check console.`);
            ui.updateRepoTitle("Error Loading Data");
        }
        // --- END MODIFIED CATCH BLOCK ---

        // Common cleanup for any error during fetch
        resetRepositoryState();
        ui.updateRepoBranch(null);
        return false;
    }
}

/** Gets current repository information including the ref used. */
function getRepoInfo() {
    return {
        url: currentRepoUrl,
        owner: currentOwner,
        repo: currentRepo,
        ref: actualRefUsed,
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

// console.log("[Popup Repository] Module loaded."); // Reduced noise