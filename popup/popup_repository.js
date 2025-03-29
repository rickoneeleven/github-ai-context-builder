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
 * Detects the current repository from the active tab URL.
 * @returns {Promise<object>} Repository information object or null if detection fails
 */
async function detectRepository() {
    log('info', "[Popup Repository] Detecting repository from active tab...");
    
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (!tabs || tabs.length === 0 || !tabs[0].url) {
            throw new Error("Could not get active tab URL");
        }
        
        currentRepoUrl = tabs[0].url;
        log('info', `[Popup Repository] Current URL: ${currentRepoUrl}`);
        
        const repoInfo = parseRepoUrl(currentRepoUrl);
        
        if (!repoInfo) {
            throw new Error("URL does not look like a GitHub repository page");
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
        log('error', "[Popup Repository] Repository detection failed:", error);
        ui.updateRepoTitle("Error Loading");
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