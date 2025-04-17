// File: popup/popup_coordinator.js
import { log } from './popup_utils.js';
import * as ui from './popup_ui.js';
import * as repository from './popup_repository.js';
import * as state from './popup_state.js';
import { renderTreeDOM } from './popup_tree_renderer.js';
import * as treeLogic from './popup_tree_logic.js';
import { initActions } from './popup_actions.js';

// console.log("[Popup Coordinator] Module loading..."); // Reduced noise

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
    // log('info', "[Popup Coordinator] Initializing application..."); // Reduced noise
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
        if (!repoInfo && !repository.getRepoInfo().url) {
             // log('error', "[Popup Coordinator] Repository detection failed critically (no URL)."); // Should be handled by detectRepo now
             ui.setRefreshDisabled(false);
             ui.updatePerformanceStats("");
            return; // Halt initialization
        }

        // Fetch repository data (tree, sizes) using detected info
        // This returns false if fetch failed (including handled ApiAuthError)
        const dataFetched = await repository.fetchRepositoryData();
        if (!dataFetched) {
            // Error message and critical logging (if needed) already handled by fetchRepositoryData
            // Log the abortion at info level, not error, as the cause might be handled (like ApiAuthError)
            // --- MODIFIED LINE: Changed log level from 'error' to 'info' ---
            log('info', "[Popup Coordinator] Repository data fetch failed or was handled downstream. Aborting further initialization.");
            ui.setRefreshDisabled(false); // Ensure refresh is enabled on fetch failure
            ui.updatePerformanceStats("");
            return; // Stop initialization
        }

        // Initialize state management
        const confirmedRepoUrl = repository.getRepoInfo().url;
        if (!confirmedRepoUrl) {
            // This should ideally not happen if dataFetched is true, but keep as safety check
            log('error', "[Popup Coordinator] Cannot initialize state: Confirmed repository URL is missing after successful fetch.");
            ui.showError("Initialization Error: Missing repository URL for state management.");
            return; // Halt
        }

        const stateModule = state.initState({
            fileTreeDataRef: repoModule.fileTreeData,
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
            getRepoInfoCallback: repository.getRepoInfo,
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
        // log('info', `[Popup Coordinator] Initialization successful in ${loadTime}s`); // Reduced noise
        ui.updatePerformanceStats(`Load time: ${loadTime}s`);
        ui.setRefreshDisabled(false); // Ensure refresh is enabled on success

    } catch (error) {
        // This catch block handles errors *during* initialization steps *other* than fetchRepositoryData failure
        log('error', "[Popup Coordinator] Initialization failed unexpectedly:", error); // Keep this critical error log

        // Check for specific known errors from detectRepository handled by repository module
        if (error.message === "not_github" || error.message === "not_repo" || error.message === "no_tab_url") {
            log('info', `[Popup Coordinator] Known condition during init: ${error.message}. UI handled by repository module.`);
            // UI messages and state are already set by detectRepository
            ui.setControlsDisabled();
            ui.setRefreshDisabled(false);
        } else {
            // For genuine unexpected errors during init (e.g., state, render, actions)
            ui.showError(`Initialization failed unexpectedly: ${error.message}. Check console for details.`);
            ui.updateRepoTitle("Error");
            ui.updateRepoBranch(null);
            ui.setControlsDisabled();
            ui.setRefreshDisabled(false);
        }

        ui.updatePerformanceStats(""); // Clear perf stats on error
    }
}

/** Caches DOM elements. */
function cacheElements() {
    // Reduced logging
    fileTreeContainer = document.getElementById('file-tree-container');
    expandAllButton = document.getElementById('expand-all');
    collapseAllButton = document.getElementById('collapse-all');
    copyButton = document.getElementById('copy-button');
    refreshButton = document.getElementById('refresh-button');

    if (!fileTreeContainer || !copyButton || !refreshButton) {
        // Keep this critical error log
        log('error', "[Popup Coordinator] CRITICAL: Essential DOM elements (tree container, copy/refresh buttons) not found!");
    }
}

/** Sets up event listeners for Expand/Collapse. */
function setupEventListeners() {
    // Reduced logging
    expandAllButton?.addEventListener('click', treeLogic.expandAll);
    collapseAllButton?.addEventListener('click', treeLogic.collapseAll);
}


/** Handler for state updates (currently handled within state module itself). */
function handleStateUpdate(stateInfo) {
    // Log for debugging if needed, but keep minimal
    // log('log', "[Popup Coordinator] State update received (for potential coordinator logic):", stateInfo);
}

/** Handler for the Refresh action. */
async function handleRefresh() {
    // log('info', "[Popup Coordinator] Refresh action triggered. Re-initializing application."); // Reduced noise
    // Reset UI immediately
    ui.clearMessages();
    ui.updateRepoTitle("Refreshing...");
    ui.updateRepoBranch(null);
    ui.setControlsDisabled();
    ui.setRefreshDisabled(true);
    ui.updatePerformanceStats("");

    if (fileTreeContainer) {
        fileTreeContainer.innerHTML = '<div class="loading-indicator">Loading file tree...</div>';
    }

    // Re-initialize the application from scratch
    // Errors within initializeApp are handled by its own try/catch
    await initializeApp();

    // Note: initializeApp() handles re-enabling refresh button on its own completion/failure paths.
}

export {
    initializeApp
};

// console.log("[Popup Coordinator] Module loaded."); // Reduced noise