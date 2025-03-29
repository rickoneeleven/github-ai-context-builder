// File: popup/popup.js
// --- Imports ---
// Common Modules
import { getRepoSelectionState, setRepoSelectionState } from '../common/storage.js';
import { parseRepoUrl, getRepoTree } from '../common/github_api.js';
// Popup Modules
import { log, formatBytes } from './popup_utils.js';
import * as ui from './popup_ui.js'; // Import all UI functions namespaced
import { renderTreeDOM } from './popup_tree_renderer.js';
import * as treeLogic from './popup_tree_logic.js'; // Import all logic functions namespaced
import { initActions } from './popup_actions.js';

console.log("[Popup] Script loading...");

// --- DOM Elements (Only those needed directly by popup.js for init) ---
let fileTreeContainer = null;
let expandAllButton = null;
let collapseAllButton = null;
let copyButton = null;      // Needed for initActions
let refreshButton = null;   // Needed for initActions

// --- Core State Variables ---
let currentRepoUrl = null;
let currentOwner = null;
let currentRepo = null;
let fileTreeData = [];      // Raw flat tree data from API { path, type, sha, size }
let selectionState = {};    // Mutable state: { 'path/to/file': true, ... } - Passed by reference to treeLogic
let isTruncated = false;    // Flag if the repo tree from API was truncated
let totalSelectedFiles = 0;
let totalSelectedSize = 0;

// --- Initialization ---

/**
 * Initializes the popup: gets URL, parses repo, loads data, initializes modules.
 */
async function initializePopup() {
    log('info', "Initializing popup...");
    const startTime = performance.now();

    // Cache essential elements early
    fileTreeContainer = document.getElementById('file-tree-container');
    expandAllButton = document.getElementById('expand-all');
    collapseAllButton = document.getElementById('collapse-all');
    copyButton = document.getElementById('copy-button');
    refreshButton = document.getElementById('refresh-button');

    // Initialize UI elements and states first
    ui.initUI();
    ui.updateRepoTitle('Loading...');
    ui.setControlsDisabled(); // Disable controls initially
    ui.showStatus("Detecting GitHub repository...");

    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0 || !tabs[0].url) {
            throw new Error("Could not get active tab URL.");
        }
        currentRepoUrl = tabs[0].url;
        log('info', `Current URL: ${currentRepoUrl}`);

        // Clear previous dynamic content and messages
        if (fileTreeContainer) fileTreeContainer.innerHTML = '';
        ui.clearMessages();

        const repoInfo = parseRepoUrl(currentRepoUrl);
        if (!repoInfo) {
            throw new Error("URL does not look like a GitHub repository page.");
        }

        currentOwner = repoInfo.owner;
        currentRepo = repoInfo.repo;
        ui.updateRepoTitle(`${currentOwner}/${currentRepo}`); // Set title via UI module

        // Load repository data, render tree, and setup interactions
        await loadRepoData();

        const endTime = performance.now();
        ui.updatePerformanceStats(`Load time: ${((endTime - startTime) / 1000).toFixed(2)}s`);

    } catch (error) {
        log('error', "Initialization failed:", error);
        ui.showError(`Initialization failed: ${error.message}`);
        ui.updateRepoTitle("Error Loading");
        ui.setControlsDisabled(); // Ensure controls are disabled on error
        ui.setRefreshDisabled(false); // Always allow refresh attempt
        ui.updatePerformanceStats(""); // Clear perf stats on error
    } finally {
        // Final check to ensure refresh is enabled if initialization didn't completely fail before loadRepoData
         if (!refreshButton?.disabled) { // Check if not already disabled by try/catch/finally logic
             ui.setRefreshDisabled(false);
         }
    }
}

/** Fetches repo tree, loads selection, initializes logic, renders tree, updates UI. */
async function loadRepoData() {
    log('info', `Loading repository data for ${currentOwner}/${currentRepo}`);
    if (fileTreeContainer) {
        fileTreeContainer.innerHTML = '<div class="loading-indicator">Loading file tree...</div>'; // Use class from CSS
    }
    ui.showStatus(`Fetching file tree for ${currentOwner}/${currentRepo}...`);
    ui.setControlsDisabled(); // Disable controls during load
    ui.setRefreshDisabled(true); // Disable refresh during load specifically

    resetState(); // Reset internal state variables

    try {
        // Fetch tree data
        const repoTreeResult = await getRepoTree(currentOwner, currentRepo);
        fileTreeData = repoTreeResult.tree.filter(item => item && (item.type === 'blob' || item.type === 'tree')); // Added item check
        isTruncated = repoTreeResult.truncated;
        log('info', `Received ${fileTreeData.length} filtered tree items. Truncated: ${isTruncated}`);

        if (fileTreeData.length === 0 && !isTruncated) {
           ui.showStatus("Repository appears to be empty or inaccessible.", true); // isWarning=true
           if (fileTreeContainer) fileTreeContainer.innerHTML = ''; // Clear loading indicator
           ui.setRefreshDisabled(false); // Allow refresh attempt
           return;
        }

        // Load persisted selection state or default, populating 'selectionState'
        await loadAndApplySelectionState();

        // Initialize Tree Logic *before* rendering
        // Pass mutable state and callbacks by reference/value
        const { updateFolderStateCallback } = treeLogic.initTreeLogic({
             container: fileTreeContainer,
             initialSelectionState: selectionState, // Pass reference to mutable state object
             initialFileTreeData: fileTreeData,    // Pass reference to data array
             saveStateCallback: saveSelectionState, // Pass function for debounced saving
             onStateUpdate: handleTreeStateUpdate // Pass function to handle updates
        });

        // Render the DOM Tree
        // Pass the updateFolderStateCallback needed by the renderer
        renderTreeDOM(fileTreeContainer, fileTreeData, selectionState, updateFolderStateCallback);

        // Calculate initial totals based on loaded/rendered state
        calculateSelectedTotals();
        // Update UI elements (counts, size, button states)
        handleTreeStateUpdate(); // Use the common update handler

        // Final UI adjustments
        ui.clearMessages(); // Clear "Loading..." message
        if (isTruncated) {
            ui.showStatus("Warning: Repository tree is large and may be incomplete.", true);
        }

    } catch (error) {
        log('error', "Failed to load repository data:", error);
        ui.showError(`Error loading data: ${error.message}. Check console.`);
        if (fileTreeContainer) fileTreeContainer.innerHTML = '<div class="error">Failed to load tree data.</div>'; // Clear loading
        ui.setControlsDisabled(); // Keep controls disabled on error
    } finally {
         // Always ensure refresh is enabled after load attempt (success or fail)
         ui.setRefreshDisabled(false);
    }
}

/** Resets the core state variables used for rendering and calculation. */
function resetState() {
    log('info', 'Resetting internal state.');
    fileTreeData = [];
    selectionState = {}; // Resetting the object reference is okay here
    isTruncated = false;
    totalSelectedFiles = 0;
    totalSelectedSize = 0;
    // Update UI immediately to reflect reset state
    handleTreeStateUpdate(); // Recalculates and updates UI (counts, buttons)
}

/** Loads persisted selection state or defaults to all selected. Modifies 'selectionState'. */
async function loadAndApplySelectionState() {
    const persistedState = await getRepoSelectionState(currentRepoUrl);
    selectionState = {}; // Start fresh for this load

    const currentKeys = new Set(fileTreeData.map(item => item && item.path ? (item.type === 'tree' ? `${item.path}/` : item.path) : null).filter(Boolean));

    if (persistedState) {
        log('info', "Applying persisted selection state.");
        // Prune state & apply defaults
        for (const key in persistedState) {
            if (currentKeys.has(key)) {
                selectionState[key] = persistedState[key];
            } else {
                 log('log', `Pruning stale key from loaded state: ${key}`);
            }
        }
        currentKeys.forEach(key => {
            if (selectionState[key] === undefined) {
                log('log', `Setting default 'true' for new/missing key: ${key}`);
                selectionState[key] = true; // Default new items to selected
            }
        });
    } else {
        log('info', "No persisted state found, defaulting to all selected.");
        currentKeys.forEach(key => {
            selectionState[key] = true; // Default all to selected
        });
    }
}

// --- Calculation Function ---
/**
 * Recalculates totals based on the current 'selectionState' and 'fileTreeData'.
 * Updates the global totalSelectedFiles and totalSelectedSize variables.
 */
function calculateSelectedTotals() {
    let count = 0;
    let size = 0;
    for (const pathKey in selectionState) {
        // Only count files (not folders) that are explicitly selected (true)
        if (selectionState[pathKey] === true && !pathKey.endsWith('/')) {
            const fileData = fileTreeData.find(item => item && item.path === pathKey && item.type === 'blob');
            if (fileData && typeof fileData.size === 'number') {
                count++;
                size += fileData.size;
            } else if (fileData) {
                log('warn', `File data found for ${pathKey} but size is missing or invalid:`, fileData.size);
            }
        }
    }
    totalSelectedFiles = count;
    totalSelectedSize = size;
}

// --- State Update Handling ---

/**
 * Callback function triggered by popup_tree_logic after selection state changes.
 * Recalculates totals and updates relevant UI elements.
 */
function handleTreeStateUpdate() {
    log('log', 'Handling tree state update...');
    calculateSelectedTotals();
    const formattedSize = formatBytes(totalSelectedSize);
    ui.updateSelectionInfo(totalSelectedFiles, formattedSize);
    const hasItems = fileTreeData.length > 0;
    const hasSelection = totalSelectedFiles > 0;
    ui.updateControlsState(hasItems, hasSelection);
}

/**
 * Persists the current selectionState to storage. Passed to tree_logic for debouncing.
 */
async function saveSelectionState() {
    log('log', "Executing saveSelectionState callback...");
    if (!currentRepoUrl) {
        log('error', "Cannot save state: currentRepoUrl is not set.");
        return;
    }
    try {
        const success = await setRepoSelectionState(currentRepoUrl, selectionState);
        if (!success) {
            log('error', "Failed to persist selection state (setRepoSelectionState returned false).");
            // Consider a non-blocking temporary UI warning if this fails often
            // ui.showStatus("Warning: Could not save selection state.", true);
            // setTimeout(ui.clearMessages, 3000);
        } else {
            // log('log', "Selection state persisted successfully.");
        }
    } catch (error) {
        log('error', "Error persisting selection state:", error);
        // ui.showStatus("Warning: Error saving selection state.", true);
        // setTimeout(ui.clearMessages, 3000);
    }
}


// --- Action Callbacks (Provided to popup_actions.js) ---

function getRepoInfoForActions() {
    return { owner: currentOwner, repo: currentRepo };
}

function getSelectionStateForActions() {
    return selectionState; // Provide direct reference
}

function getFileTreeDataForActions() {
    return fileTreeData; // Provide direct reference
}

function triggerRefreshAction() {
    log('info', "Refresh triggered via action callback.");
    // Re-run the main initialization function
    initializePopup();
}


// --- DOMContentLoaded Listener ---
document.addEventListener('DOMContentLoaded', () => {
    log('info', "DOM Content Loaded. Starting initialization...");

    // Run the main initialization sequence
    initializePopup(); // This now handles UI init internally

    // Initialize Actions module after main elements are cached by initializePopup
    if (copyButton && refreshButton) {
        try {
            initActions({
                copyButtonElement: copyButton,
                refreshButtonElement: refreshButton,
                getRepoInfoCallback: getRepoInfoForActions,
                getSelectionStateCallback: getSelectionStateForActions,
                getFileTreeDataCallback: getFileTreeDataForActions,
                triggerRefreshCallback: triggerRefreshAction
            });
            log('info', "Actions module initialized.");
        } catch (error) {
             log('error', "Failed to initialize Actions module:", error);
             ui.showError("Failed to initialize actions. Buttons may not work.");
        }
    } else {
         log('error', "Cannot initialize Actions module: Copy or Refresh button not found.");
    }


    // Attach listeners for Expand/Collapse buttons (calling treeLogic functions)
    if (expandAllButton) {
        expandAllButton.addEventListener('click', treeLogic.expandAll);
    }
    if (collapseAllButton) {
        collapseAllButton.addEventListener('click', treeLogic.collapseAll);
    }

    log('info', "Popup script setup complete.");
});

log('info', "Popup script loaded.");