// File: popup/popup_coordinator.js
import { log } from './popup_utils.js';
import * as ui from './popup_ui.js';
import * as repository from './popup_repository.js';
import * as state from './popup_state.js';
import { renderTreeDOM } from './popup_tree_renderer.js';
import * as treeLogic from './popup_tree_logic.js';
import { initActions } from './popup_actions.js';

console.log("[Popup Coordinator] Module loading...");

// --- DOM Elements ---
let fileTreeContainer = null;
let expandAllButton = null;
let collapseAllButton = null;
let copyButton = null;
let refreshButton = null;

// --- Module References ---
let updateFolderStateCallback = null;
let repoModule = null; // Store reference to repo module instance

/**
 * Initializes the application.
 * This is the main entry point called from popup.js.
 */
async function initializeApp() {
    log('info', "[Popup Coordinator] Initializing application...");
    const startTime = performance.now();

    // Initialize UI
    cacheElements();
    ui.initUI();
    ui.clearMessages();
    ui.updateRepoTitle('Loading...');
    ui.setControlsDisabled();
    ui.showStatus("Detecting GitHub repository...");

    try {
        // Initialize modules (Store repo module reference)
        repoModule = repository.initRepository(); // Store the returned object

        // Detect repository from active tab
        const repoInfo = await repository.detectRepository();
        if (!repoInfo) {
            // Repository module handles UI for non-GitHub/non-repo pages via specific errors
            // The error handling below will catch "not_github" or "not_repo"
            log('info', "[Popup Coordinator] Repository detection incomplete or failed. Initialization may halt.");
            // Return early if detection truly fails without specific error handled below
            // This path might be taken if chrome.tabs.query fails initially.
             if (!currentRepoUrl) { // Check if repo URL was ever set
                 ui.showError("Could not determine current tab URL.");
                 ui.setRefreshDisabled(false);
                 ui.updatePerformanceStats("");
                 return;
             }
        }

        // Fetch repository data (includes folder size calculation now)
        const dataFetched = await repository.fetchRepositoryData();
        if (!dataFetched) {
            // Error message already shown by fetchRepositoryData
            log('error', "[Popup Coordinator] Repository data fetch failed. Aborting initialization.");
            // Ensure refresh is enabled
             ui.setRefreshDisabled(false);
             ui.updatePerformanceStats(""); // Clear perf on error
            return; // Stop initialization
        }

        // Initialize state module with repository data reference
        // Use the stored repoModule reference to access fileTreeData
        const stateModule = state.initState({
            fileTreeDataRef: repoModule.fileTreeData, // Pass reference correctly
            repoUrl: repository.getRepoInfo().url, // Get current URL after detection/fetch
            onStateUpdateCallback: handleStateUpdate
        });

        // Load persisted selection state
        const selectionState = await state.loadAndApplySelectionState();

        // Initialize tree logic with state references
        // Use the stored repoModule reference to access fileTreeData
        const treeLogicResult = treeLogic.initTreeLogic({
            container: fileTreeContainer,
            initialSelectionState: selectionState, // Direct reference to loaded state
            initialFileTreeData: repoModule.fileTreeData, // Pass reference correctly
            saveStateCallback: state.saveSelectionState, // Pass save function
            onStateUpdate: state.handleTreeStateUpdate // Pass update handler
        });

        // Store callback for tree rendering
        updateFolderStateCallback = treeLogicResult.updateFolderStateCallback;

        // --- MODIFIED: Get folder sizes and pass to renderer ---
        const folderSizes = repository.getFolderSizes(); // Get the calculated sizes

        // Render the tree, passing folderSizes
        renderTreeDOM(
            fileTreeContainer,
            repoModule.fileTreeData, // Pass reference correctly
            selectionState, // Use direct reference to loaded state
            updateFolderStateCallback,
            folderSizes // Pass the folder sizes map
        );
        // --- END MODIFICATION ---

        // Initialize actions module
        initActions({
            copyButtonElement: copyButton,
            refreshButtonElement: refreshButton,
            getRepoInfoCallback: repository.getRepoInfo,
            getSelectionStateCallback: state.getSelectionStateForActions,
            getFileTreeDataCallback: repository.getFileTreeData,
            triggerRefreshCallback: handleRefresh // Use the local handler
        });

        // Set up button listeners (Expand/Collapse)
        setupEventListeners();

        // Update UI with initial state (selection count, button states)
        // This now calls ui.updateControlsState indirectly
        state.handleTreeStateUpdate();

        // Ensure all checkboxes reflect the current selection state visually
        // updateCheckboxesFromState(selectionState); // Might be redundant if renderTreeDOM + updateFolderCheckboxStateCallback handle it

        ui.clearMessages(); // Clear any loading messages

        const endTime = performance.now();
        const loadTime = ((endTime - startTime) / 1000).toFixed(2);
        log('info', `[Popup Coordinator] Initialization successful in ${loadTime}s`);
        ui.updatePerformanceStats(`Load time: ${loadTime}s`);


    } catch (error) {
        log('error', "[Popup Coordinator] Initialization failed:", error);

        // Check for specific error messages handled by repository module
        if (error.message === "not_github" || error.message === "not_repo") {
            // UI messages already handled by repository.detectRepository
            log('info', `[Popup Coordinator] Expected condition: ${error.message}. UI handled by repository module.`);
            // Ensure controls are correctly set for these states
             ui.setControlsDisabled(); // Disable non-essential controls
             ui.setRefreshDisabled(false); // Ensure refresh is possible
        } else {
            // For genuine unexpected errors, display the error message
            ui.showError(`Initialization failed: ${error.message}`);
            ui.updateRepoTitle("Error Loading");
            ui.setControlsDisabled(); // Disable most controls
        }

        ui.setRefreshDisabled(false); // Always allow refresh attempt on any error
        ui.updatePerformanceStats(""); // Clear perf stats on error
    }
    // Removed finally block that just enabled refresh, as error paths handle it.
}

// cacheElements function remains the same...
/**
 * Caches DOM elements for later use.
 */
function cacheElements() {
    log('info', "[Popup Coordinator] Caching DOM elements...");
    fileTreeContainer = document.getElementById('file-tree-container');
    expandAllButton = document.getElementById('expand-all');
    collapseAllButton = document.getElementById('collapse-all');
    copyButton = document.getElementById('copy-button');
    refreshButton = document.getElementById('refresh-button');

    if (!fileTreeContainer || !expandAllButton || !collapseAllButton || !copyButton || !refreshButton) {
        log('warn', "[Popup Coordinator] One or more required DOM elements not found during caching.");
        // Consider throwing an error if essential elements are missing, or handle gracefully.
    }
}

// setupEventListeners function remains the same...
/**
 * Sets up event listeners for UI elements like expand/collapse.
 * Action button listeners (Copy/Refresh) are set up in initActions.
 */
function setupEventListeners() {
    log('info', "[Popup Coordinator] Setting up event listeners for expand/collapse...");

    // Use a safe check before adding listeners
    expandAllButton?.addEventListener('click', treeLogic.expandAll);
    collapseAllButton?.addEventListener('click', treeLogic.collapseAll);
}


// handleStateUpdate function remains the same...
/**
 * Handler for state updates from the state module.
 * Currently, the state module updates UI directly via popup_ui calls within its handleTreeStateUpdate.
 * This function could be used for more complex coordinator-level logic reacting to state changes if needed later.
 * @param {object} stateInfo - State information object passed from the state module's callback.
 */
function handleStateUpdate(stateInfo) {
    // Example: log('log', "[Popup Coordinator] State update received:", stateInfo);
    // The actual UI updates (selection count, button states) are triggered
    // within state.handleTreeStateUpdate() which calls ui functions.
}


// updateCheckboxesFromState seems redundant now - renderTreeDOM sets initial checked state
// and updateFolderCheckboxState (called by renderer and logic) handles folder states. Removing it for now.
/*
function updateCheckboxesFromState(selectionState) { ... }
*/

/**
 * Handler for refresh action.
 * Triggered when the refresh button is clicked via popup_actions.
 * Resets UI and re-initializes the entire application flow.
 */
function handleRefresh() {
    log('info', "[Popup Coordinator] Refresh action triggered. Re-initializing application.");
    // Reset UI immediately
    ui.clearMessages();
    ui.updateRepoTitle("Refreshing...");
    ui.setControlsDisabled(); // Disable controls
    ui.setRefreshDisabled(true); // Disable refresh button during refresh
    ui.updatePerformanceStats(""); // Clear old stats

    if (fileTreeContainer) {
        fileTreeContainer.innerHTML = '<div class="loading-indicator">Loading file tree...</div>'; // Show loading indicator
    } else {
         log('warn', "[Popup Coordinator] File tree container not found during refresh.");
    }

    // Re-initialize the application from scratch
    // Wrap in a try/catch to ensure refresh button is re-enabled even if re-init fails
    try {
         initializeApp(); // This is async but we don't necessarily need to await it here
                         // It handles its own errors and UI updates.
    } catch (error) {
        log('error', "[Popup Coordinator] Error during refresh's initializeApp call:", error);
         // initializeApp should handle its own UI error display.
         // Ensure refresh is re-enabled if something unexpected goes wrong here.
         ui.setRefreshDisabled(false);
    }
     // Note: initializeApp() handles re-enabling refresh on its completion/failure.
}

export {
    initializeApp
};

console.log("[Popup Coordinator] Module loaded.");