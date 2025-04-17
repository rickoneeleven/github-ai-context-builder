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
 */
async function initializeApp() {
    log('info', "[Popup Coordinator] Initializing application...");
    const startTime = performance.now();

    // Initialize UI: Cache elements, set initial states
    cacheElements();
    ui.initUI();
    ui.clearMessages();
    ui.setControlsDisabled(); // Disable controls initially
    ui.showStatus("Detecting GitHub repository..."); // Initial status

    try {
        // Initialize repo module (returns getters/references)
        repoModule = repository.initRepository();

        // Detect repository from active tab (updates UI for title/branch)
        const repoInfo = await repository.detectRepository();
        // If detectRepository throws specific errors (not_github, not_repo, no_tab_url),
        // it handles UI updates and the error is caught below.
        // If it returns null unexpectedly, we might still have issues.
        if (!repoInfo && !repository.getRepoInfo().url) {
            // This condition checks if detection failed AND no URL was ever set.
            // Should be covered by specific errors now, but good safety check.
            log('error', "[Popup Coordinator] Repository detection failed critically (no URL).");
            // UI error likely already shown by detectRepository or its callers
            ui.setRefreshDisabled(false);
            ui.updatePerformanceStats("");
            return; // Halt initialization
        }

        // Fetch repository data (tree, sizes) using detected info
        const dataFetched = await repository.fetchRepositoryData();
        if (!dataFetched) {
            // Error message already shown by fetchRepositoryData
            log('error', "[Popup Coordinator] Repository data fetch failed. Aborting initialization.");
            ui.setRefreshDisabled(false); // Ensure refresh is enabled on fetch failure
            ui.updatePerformanceStats("");
            return; // Stop initialization
        }

        // Initialize state management
        // Pass the REPO URL confirmed after detection/fetch
        const confirmedRepoUrl = repository.getRepoInfo().url;
        if (!confirmedRepoUrl) {
            log('error', "[Popup Coordinator] Cannot initialize state: Confirmed repository URL is missing after fetch.");
            ui.showError("Initialization Error: Missing repository URL for state management.");
            return; // Halt
        }

        const stateModule = state.initState({
            fileTreeDataRef: repoModule.fileTreeData, // Reference to the actual data array
            repoUrl: confirmedRepoUrl,
            onStateUpdateCallback: handleStateUpdate
        });

        // Load persisted selection state (or default)
        const selectionState = await state.loadAndApplySelectionState();

        // Initialize tree logic
        const treeLogicResult = treeLogic.initTreeLogic({
            container: fileTreeContainer,
            initialSelectionState: selectionState,
            initialFileTreeData: repoModule.fileTreeData,
            saveStateCallback: state.saveSelectionState,
            onStateUpdate: state.handleTreeStateUpdate
        });
        updateFolderStateCallback = treeLogicResult.updateFolderStateCallback;

        // Get calculated folder sizes
        const folderSizes = repository.getFolderSizes();

        // Render the tree DOM
        renderTreeDOM(
            fileTreeContainer,
            repoModule.fileTreeData,
            selectionState,
            updateFolderStateCallback,
            folderSizes
        );

        // Initialize action handlers (Copy/Refresh buttons)
        initActions({
            copyButtonElement: copyButton,
            refreshButtonElement: refreshButton,
            getRepoInfoCallback: repository.getRepoInfo, // Provides owner, repo, actualRefUsed
            getSelectionStateCallback: state.getSelectionStateForActions,
            getFileTreeDataCallback: repository.getFileTreeData,
            triggerRefreshCallback: handleRefresh
        });

        // Setup Expand/Collapse listeners
        setupEventListeners();

        // Trigger initial UI update based on loaded state (counts, button enablement)
        state.handleTreeStateUpdate();

        // Clear any lingering "Loading..." messages
        ui.clearMessages();

        const endTime = performance.now();
        const loadTime = ((endTime - startTime) / 1000).toFixed(2);
        log('info', `[Popup Coordinator] Initialization successful in ${loadTime}s`);
        ui.updatePerformanceStats(`Load time: ${loadTime}s`);
        ui.setRefreshDisabled(false); // Ensure refresh is enabled on success

    } catch (error) {
        log('error', "[Popup Coordinator] Initialization failed:", error);

        // Check for specific known errors handled by repository module
        if (error.message === "not_github" || error.message === "not_repo" || error.message === "no_tab_url") {
            log('info', `[Popup Coordinator] Known condition during init: ${error.message}. UI handled by repository module.`);
            // UI messages and state are already set by detectRepository
            ui.setControlsDisabled(); // Ensure non-essentials are disabled
            ui.setRefreshDisabled(false); // Ensure refresh is possible
        } else {
            // For genuine unexpected errors
            ui.showError(`Initialization failed unexpectedly: ${error.message}. Check console for details.`);
            ui.updateRepoTitle("Error");
            ui.updateRepoBranch(null); // Clear branch display
            ui.setControlsDisabled(); // Disable most controls
            ui.setRefreshDisabled(false); // Allow refresh attempt
        }

        ui.updatePerformanceStats(""); // Clear perf stats on error
    }
}

/** Caches DOM elements. */
function cacheElements() {
    // log('info', "[Popup Coordinator] Caching DOM elements..."); // Reduced logging
    fileTreeContainer = document.getElementById('file-tree-container');
    expandAllButton = document.getElementById('expand-all');
    collapseAllButton = document.getElementById('collapse-all');
    copyButton = document.getElementById('copy-button');
    refreshButton = document.getElementById('refresh-button');

    // Basic check if essential elements are missing
    if (!fileTreeContainer || !copyButton || !refreshButton) {
        log('error', "[Popup Coordinator] CRITICAL: Essential DOM elements (tree container, copy/refresh buttons) not found!");
        // Consider throwing an error or displaying a fatal UI error
        // For now, logging error. Subsequent code will likely fail.
    }
}

/** Sets up event listeners for Expand/Collapse. */
function setupEventListeners() {
    // log('info', "[Popup Coordinator] Setting up expand/collapse listeners..."); // Reduced logging
    expandAllButton?.addEventListener('click', treeLogic.expandAll);
    collapseAllButton?.addEventListener('click', treeLogic.collapseAll);
}


/** Handler for state updates (currently handled within state module itself). */
function handleStateUpdate(stateInfo) {
    // log('log', "[Popup Coordinator] State update received (for potential coordinator logic):", stateInfo);
    // Actual UI updates are triggered within state.handleTreeStateUpdate() -> ui functions
}

/** Handler for the Refresh action. */
async function handleRefresh() { // Made async for consistency, though initializeApp handles async internally
    log('info', "[Popup Coordinator] Refresh action triggered. Re-initializing application.");
    // Reset UI immediately
    ui.clearMessages();
    ui.updateRepoTitle("Refreshing...");
    ui.updateRepoBranch(null); // Clear branch display
    ui.setControlsDisabled(); // Disable controls
    ui.setRefreshDisabled(true); // Disable refresh button *during* refresh
    ui.updatePerformanceStats(""); // Clear old stats

    if (fileTreeContainer) {
        fileTreeContainer.innerHTML = '<div class="loading-indicator">Loading file tree...</div>';
    }

    // Re-initialize the application from scratch
    try {
        await initializeApp(); // Await initialization to ensure completion before potential next actions
    } catch (error) {
        // Should be caught by initializeApp's own try/catch, but as a safeguard:
        log('error', "[Popup Coordinator] Error during refresh's initializeApp call (Coordinator level):", error);
        ui.showError(`Refresh failed: ${error.message}`);
        ui.setRefreshDisabled(false); // Ensure refresh is re-enabled if something unexpected goes wrong here
    }
    // Note: initializeApp() handles re-enabling refresh button on its own completion/failure paths.
}

export {
    initializeApp
};

console.log("[Popup Coordinator] Module loaded.");