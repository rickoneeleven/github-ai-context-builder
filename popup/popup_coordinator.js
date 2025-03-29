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
        // Initialize modules
        const repoModule = repository.initRepository();
        
        // Detect repository from active tab
        const repoInfo = await repository.detectRepository();
        // If repoInfo is null, the repository module has already handled
        // displaying the appropriate error message to the user
        if (!repoInfo) {
            // This is an expected condition for non-GitHub pages, not an error
            log('info', "[Popup Coordinator] No valid repository detected. UI has been updated accordingly.");
            // Always ensure refresh is enabled for recovery
            ui.setRefreshDisabled(false);
            
            // End initialization gracefully without throwing an error
            ui.updatePerformanceStats("");
            return;
        }
        
        // Fetch repository data
        const dataFetched = await repository.fetchRepositoryData();
        if (!dataFetched) {
            throw new Error("Repository data fetch failed");
        }
        
        // Initialize state module with repository data reference
        const stateModule = state.initState({
            fileTreeDataRef: repoModule.fileTreeData,
            repoUrl: repoInfo.url,
            onStateUpdateCallback: handleStateUpdate
        });
        
        // Load persisted selection state
        const selectionState = await state.loadAndApplySelectionState();
        
        // Initialize tree logic with state references
        const treeLogicResult = treeLogic.initTreeLogic({
            container: fileTreeContainer,
            initialSelectionState: selectionState, // Direct reference to loaded state
            initialFileTreeData: repoModule.fileTreeData,
            saveStateCallback: state.saveSelectionState,
            onStateUpdate: state.handleTreeStateUpdate
        });
        
        // Store callback for tree rendering
        updateFolderStateCallback = treeLogicResult.updateFolderStateCallback;
        
        // Render the tree
        renderTreeDOM(
            fileTreeContainer,
            repoModule.fileTreeData,
            selectionState, // Use direct reference to loaded state
            updateFolderStateCallback
        );
        
        // Initialize actions module
        initActions({
            copyButtonElement: copyButton,
            refreshButtonElement: refreshButton,
            getRepoInfoCallback: repository.getRepoInfo,
            getSelectionStateCallback: state.getSelectionStateForActions,
            getFileTreeDataCallback: repository.getFileTreeData,
            triggerRefreshCallback: handleRefresh
        });
        
        // Set up button listeners
        setupEventListeners();
        
        // Update UI with initial state
        state.handleTreeStateUpdate();
        
        // Ensure all checkboxes reflect the current selection state
        updateCheckboxesFromState(selectionState);
        
        ui.clearMessages();
        
        const endTime = performance.now();
        ui.updatePerformanceStats(`Load time: ${((endTime - startTime) / 1000).toFixed(2)}s`);
        
    } catch (error) {
        log('error', "[Popup Coordinator] Initialization failed:", error);
        
        // Check for specific error messages that would have been handled by the repository module
        if (error.message === "not_github" || error.message === "not_repo") {
            // These are already handled by repository module, don't show additional errors
            log('info', `[Popup Coordinator] Expected condition: ${error.message}. Already handled.`);
        } else {
            // For genuine errors, display the error message
            ui.showError(`Initialization failed: ${error.message}`);
            ui.updateRepoTitle("Error Loading");
        }
        
        ui.setControlsDisabled();
        ui.setRefreshDisabled(false); // Always allow refresh attempt
        ui.updatePerformanceStats(""); // Clear perf stats on error
    } finally {
        // Always ensure refresh is enabled
        ui.setRefreshDisabled(false);
    }
}

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
        log('warn', "[Popup Coordinator] One or more required DOM elements not found");
    }
}

/**
 * Sets up event listeners for UI elements.
 */
function setupEventListeners() {
    log('info', "[Popup Coordinator] Setting up event listeners...");
    
    // Attach listeners for Expand/Collapse buttons
    if (expandAllButton) {
        expandAllButton.addEventListener('click', treeLogic.expandAll);
    }
    
    if (collapseAllButton) {
        collapseAllButton.addEventListener('click', treeLogic.collapseAll);
    }
}

/**
 * Handler for state updates from the state module.
 * @param {object} stateInfo - State information object
 */
function handleStateUpdate(stateInfo) {
    log('log', "[Popup Coordinator] Handling state update");
    // This is called by the state module when selection changes
    // Could add additional coordinator-level logic here if needed
}

/**
 * Handler for refresh action.
 * Triggered when the refresh button is clicked.
 */
/**
 * Updates all checkboxes in the DOM to match the current selection state.
 * @param {object} selectionState - The current selection state object
 */
function updateCheckboxesFromState(selectionState) {
    log('info', "[Popup Coordinator] Updating checkbox visuals from state");
    
    if (!fileTreeContainer) return;
    
    // Find all checkboxes in the tree
    const checkboxes = fileTreeContainer.querySelectorAll('input[type="checkbox"][data-path]');
    
    // Update each checkbox based on the selection state
    checkboxes.forEach(checkbox => {
        const pathKey = checkbox.dataset.path;
        if (pathKey && selectionState.hasOwnProperty(pathKey)) {
            checkbox.checked = !!selectionState[pathKey];
            
            // If it's a folder, we might need to update indeterminate state
            if (pathKey.endsWith('/') && updateFolderStateCallback) {
                updateFolderStateCallback(checkbox, pathKey);
            }
        }
    });
}

function handleRefresh() {
    log('info', "[Popup Coordinator] Refresh action triggered");
    // Reset UI
    ui.clearMessages();
    ui.updateRepoTitle("Refreshing...");
    ui.setControlsDisabled();
    ui.setRefreshDisabled(true);
    
    if (fileTreeContainer) {
        fileTreeContainer.innerHTML = '<div class="loading-indicator">Loading file tree...</div>';
    }
    
    // Re-initialize the application
    initializeApp();
}

export {
    initializeApp
};

console.log("[Popup Coordinator] Module loaded.");