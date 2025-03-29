// File: popup/popup_repository.js
import { log } from './popup_utils.js';
import { parseRepoUrl, getRepoTree } from '../common/github_api.js';
import * as ui from './popup_ui.js';

console.log("[Popup Repository] Module loading...");

// --- Repository State ---
let currentRepoUrl = null;
let currentOwner = null;
let currentRepo = null;
let fileTreeData = [];
let isTruncated = false;

// --- Public API ---

/**
 * Initializes the repository module.
 * @returns {object} Object containing references to repository data
 */
function initRepository() {
    log('info', "[Popup Repository] Initializing repository module...");
    
    // Reset state to start fresh
    resetRepositoryState();
    
    log('info', "[Popup Repository] Repository module initialized");
    return { 
        fileTreeData, // Return reference to the file tree data array
        getRepoInfo: getRepoInfo, // Function to get current repo info
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
}

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

/**
 * Detects the current repository from the active tab URL.
 * @returns {Promise<object>} Repository information object or null if detection fails
 */
async function detectRepository() {
    log('info', "[Popup Repository] Detecting repository from active tab...");
    
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (!tabs || tabs.length === 0 || !tabs[0].url) {
            throw new Error("Could not access the current tab");
        }
        
        currentRepoUrl = tabs[0].url;
        log('info', `[Popup Repository] Current URL: ${currentRepoUrl}`);
        
        // Check if we're on GitHub before trying to parse the repo URL
        if (!isGitHubUrl(currentRepoUrl)) {
            // This is not an error, just an expected condition
            log('info', "[Popup Repository] Not on a GitHub site. URL:", currentRepoUrl);
            
            ui.updateRepoTitle("Not a Repository");
            ui.showFriendlyError(
                "This extension only works on GitHub repositories",
                "Please navigate to a GitHub repository page and try again."
            );
            
            return null;
        }
        
        const repoInfo = parseRepoUrl(currentRepoUrl);
        
        if (!repoInfo) {
            // This is also not an error, just an expected condition
            log('info', "[Popup Repository] Not on a GitHub repository page. URL:", currentRepoUrl);
            
            ui.updateRepoTitle("Not a Repository");
            ui.showFriendlyError(
                "Not a GitHub repository page",
                "Please navigate to the main page or code tab of a GitHub repository."
            );
            
            return null;
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
        // Only use error logging for unexpected errors
        log('error', "[Popup Repository] Unexpected error during repository detection:", error);
        ui.updateRepoTitle("Error");
        ui.showError(`Repository detection failed: ${error.message}`);
        return null;
    }
}

/**
 * Fetches the repository file tree data from GitHub API.
 * @returns {Promise<boolean>} True if data fetch was successful, false otherwise
 */
async function fetchRepositoryData() {
    log('info', `[Popup Repository] Fetching repository data for ${currentOwner}/${currentRepo}`);
    
    ui.showStatus(`Fetching file tree for ${currentOwner}/${currentRepo}...`);
    
    try {
        // Validate we have owner and repo set
        if (!currentOwner || !currentRepo) {
            throw new Error("Repository owner or name is not set");
        }
        
        // Fetch tree data from GitHub API
        const repoTreeResult = await getRepoTree(currentOwner, currentRepo);
        
        // Filter valid tree items
        const treeData = repoTreeResult.tree.filter(item => 
            item && (item.type === 'blob' || item.type === 'tree')
        );
        
        // Update module state
        fileTreeData.length = 0; // Clear without changing reference
        fileTreeData.push(...treeData); // Add all items to existing array
        isTruncated = repoTreeResult.truncated;
        
        log('info', `[Popup Repository] Received ${fileTreeData.length} filtered tree items. Truncated: ${isTruncated}`);
        
        if (fileTreeData.length === 0 && !isTruncated) {
            ui.showStatus("Repository appears to be empty or inaccessible.", true);
            return false;
        }
        
        // Show truncation warning if needed
        if (isTruncated) {
            ui.showStatus("Warning: Repository tree is large and may be incomplete.", true);
        }
        
        return true;
        
    } catch (error) {
        log('error', "[Popup Repository] Failed to fetch repository data:", error);
        ui.showError(`Error loading data: ${error.message}. Check console.`);
        return false;
    }
}

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

/**
 * Gets the file tree data array.
 * @returns {Array} Array of file tree items
 */
function getFileTreeData() {
    return fileTreeData;
}

export {
    initRepository,
    resetRepositoryState,
    detectRepository,
    fetchRepositoryData,
    getRepoInfo,
    getFileTreeData
};

console.log("[Popup Repository] Module loaded.");