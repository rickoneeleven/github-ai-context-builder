// File: popup/popup_tree_logic.js
import { log, getDescendantPaths, getParentFolderPath, debounce, CHECKBOX_DEBOUNCE_DELAY } from './popup_utils.js';

console.log("[Popup Tree Logic] Module loading...");

// --- Constants ---
const COLLAPSED_ICON = '\u25B6'; // ►
const EXPANDED_ICON = '\u25BC'; // ▼

// --- Module State ---
let fileTreeContainer = null;
let selectionState = null; // Reference to the mutable selection state object
let fileTreeData = null; // Reference to the flat file tree data array
let debouncedSaveCallback = null; // Function to call for debounced state saving
let afterStateUpdateCallback = null; // Callback to notify main module state changed

// --- Private Helper Functions ---

/**
 * Updates a folder's checkbox visual state (checked, unchecked, indeterminate)
 * based on its direct children's states found in the selectionState object.
 * Also updates the selectionState for the folder itself based on the calculated state.
 * This function is intended to be passed to the renderer and called during/after rendering,
 * and also during upward propagation.
 * @param {HTMLInputElement | string} checkboxOrPathKey - The folder's checkbox element OR its path key.
 * @param {string} [folderPathKeyOptional] - The folder's path key (required if checkbox element is passed).
 */
function updateFolderCheckboxState(checkboxOrPathKey, folderPathKeyOptional) {
    let checkbox;
    let folderPathKey;

    if (typeof checkboxOrPathKey === 'string') {
        folderPathKey = checkboxOrPathKey;
        checkbox = fileTreeContainer?.querySelector(`input[type="checkbox"][data-path="${CSS.escape(folderPathKey)}"]`);
    } else {
        checkbox = checkboxOrPathKey;
        folderPathKey = folderPathKeyOptional || checkbox?.dataset?.path;
    }

    if (!checkbox) {
        // This can happen if the DOM isn't fully ready or the element is gone (e.g., during refresh)
        // log('warn', `[Tree Logic] updateFolderCheckboxState: Checkbox DOM element not found for path: ${folderPathKey}`);
        return;
    }
     if (!folderPathKey || !folderPathKey.endsWith('/')) {
         log('warn', `[Tree Logic] updateFolderCheckboxState: Invalid or non-folder path key: ${folderPathKey}`);
         return;
     }
     if (!selectionState) {
          log('warn', `[Tree Logic] updateFolderCheckboxState: selectionState not available.`);
          return;
     }


    // Find direct children by checking whose parent is this folder
    const directChildrenKeys = Object.keys(selectionState).filter(k => getParentFolderPath(k) === folderPathKey);

    if (directChildrenKeys.length === 0) {
        // No children tracked in state. Checkbox state determines folder state.
        checkbox.indeterminate = false;
        // Ensure selection state matches the visual state if there are no children influencing it.
        // This handles cases where a folder might be checked/unchecked manually or by default load.
        selectionState[folderPathKey] = checkbox.checked;
        // log('log', `[Tree Logic] Folder ${folderPathKey} has no tracked children. State: ${checkbox.checked}`);
        return;
    }

    const childrenStates = directChildrenKeys.map(k => selectionState[k]);
    const allChecked = childrenStates.every(state => state === true);
    const noneChecked = childrenStates.every(state => state === false || state === undefined); // Treat undefined as false

    // Update Checkbox Visual State and Internal Selection State
    if (allChecked) {
        selectionState[folderPathKey] = true;
        checkbox.checked = true;
        checkbox.indeterminate = false;
        // log('log', `[Tree Logic] Folder ${folderPathKey} set to checked (all children checked).`);
    } else if (noneChecked) {
        selectionState[folderPathKey] = false;
        checkbox.checked = false;
        checkbox.indeterminate = false;
        // log('log', `[Tree Logic] Folder ${folderPathKey} set to unchecked (none children checked).`);
    } else { // Mixed states
        selectionState[folderPathKey] = false; // Treat indeterminate as 'not fully selected'
        checkbox.checked = false; // Visually appears unchecked
        checkbox.indeterminate = true;
        // log('log', `[Tree Logic] Folder ${folderPathKey} set to indeterminate (mixed children states).`);
    }
}


/**
 * Propagates the selection state change downwards to all descendants in the selectionState object
 * and updates their corresponding checkboxes in the DOM.
 * @param {string} folderPathKey - The path key of the folder that changed.
 * @param {boolean} isChecked - The new checked state to propagate.
 */
function propagateStateToDescendants(folderPathKey, isChecked) {
    log('log', `[Tree Logic] Propagating state (${isChecked}) down from ${folderPathKey}`);
    // Use fileTreeData passed during init to find all potential descendants
    const descendants = getDescendantPaths(folderPathKey, fileTreeData);

    descendants.forEach(descendantPathKey => {
        // Update internal state
        selectionState[descendantPathKey] = isChecked;

        // Update descendant checkboxes visually in the DOM
        const descendantCheckbox = fileTreeContainer?.querySelector(`input[type="checkbox"][data-path="${CSS.escape(descendantPathKey)}"]`);
        if (descendantCheckbox) {
            descendantCheckbox.checked = isChecked;
            descendantCheckbox.indeterminate = false; // Direct descendant state is explicit
        }
    });
}

/**
 * Updates the checked and indeterminate state of ancestor folders based on their children's states,
 * moving up the hierarchy from the changed item.
 * @param {string} changedPathKey - The path key of the item that triggered the update.
 */
function propagateStateToAncestors(changedPathKey) {
    log('log', `[Tree Logic] Propagating state up from ${changedPathKey}`);
    let parentPathKey = getParentFolderPath(changedPathKey);
    while (parentPathKey) {
        // updateFolderCheckboxState handles both DOM and internal selectionState update for the parent
        updateFolderCheckboxState(parentPathKey); // Pass path key

        // Move to the next parent up
        parentPathKey = getParentFolderPath(parentPathKey);
    }
}

// --- Event Handlers ---

/**
 * Handles checkbox change events delegated from the tree container.
 * @param {Event} event - The change event object.
 */
function handleCheckboxChange(event) {
    if (event.target.type !== 'checkbox' || !event.target.dataset.path) {
        return; // Ignore clicks on non-checkbox elements or those missing path
    }

    const checkbox = event.target;
    const pathKey = checkbox.dataset.path;
    let isChecked = checkbox.checked; // The state *after* the click

    log('log', `[Tree Logic] Checkbox changed: ${pathKey}, Checked: ${isChecked}, Indeterminate Before: ${checkbox.indeterminate}`);

    // --- State Update ---
    // If it *was* indeterminate, clicking makes it checked/unchecked definitively. Clear indeterminate.
    if (checkbox.indeterminate) {
        checkbox.indeterminate = false;
        // Often, clicking indeterminate makes it checked. Ensure internal state matches visual outcome.
        isChecked = checkbox.checked;
    }

    // Update the selectionState for the clicked item itself
    selectionState[pathKey] = isChecked;

    // --- Propagation ---
    const isFolder = pathKey.endsWith('/');
    if (isFolder) {
        // 1. Downwards: If a folder was changed, update all its descendants
        propagateStateToDescendants(pathKey, isChecked);
    }
    // 2. Upwards: Update states of all parent folders
    propagateStateToAncestors(pathKey);

    // --- Persistence & Notification ---
    // Trigger the debounced save callback provided during initialization
    if (debouncedSaveCallback) {
        debouncedSaveCallback();
    } else {
        log('warn', "[Tree Logic] Debounced save callback is not configured.");
    }
    // Notify the main module that the state has been updated
    if (afterStateUpdateCallback) {
         afterStateUpdateCallback();
    }
}

/**
 * Handles click events delegated from the tree container, specifically for toggling folders.
 * @param {Event} event - The click event object.
 */
function handleTreeClick(event) {
    // Check if the click target is specifically the toggler span
    if (event.target.classList.contains('toggler')) {
        const toggler = event.target;
        const nodeLi = toggler.closest('.tree-node.folder'); // Find the parent folder LI

        // Ensure we are on a folder LI and it actually has children UL to toggle
        if (nodeLi && nodeLi.querySelector(':scope > .tree-node-children')) {
            log('log', `[Tree Logic] Toggler clicked for: ${nodeLi.dataset.path}`);
            const isCollapsed = nodeLi.classList.toggle('collapsed');
            toggler.textContent = isCollapsed ? COLLAPSED_ICON : EXPANDED_ICON;

            // Stop the event from bubbling further (e.g., to label/checkbox)
            event.stopPropagation();
        } else if (nodeLi) {
            // Clicked toggler area on a folder with no children, do nothing significant.
            // Still stop propagation just in case.
            event.stopPropagation();
        }
    }
    // Let other clicks (e.g., on label triggering checkbox) bubble up.
}


// --- Public Functions ---

/**
 * Expands all collapsible folders in the tree.
 */
function expandAll() {
    log('info', "[Tree Logic] Expanding all folders.");
    if (!fileTreeContainer) return;
    const togglers = fileTreeContainer.querySelectorAll('.tree-node.folder .toggler');
    togglers.forEach(toggler => {
        const nodeLi = toggler.closest('.tree-node.folder');
        // Check if it has children UL and is currently collapsed
        if (nodeLi && nodeLi.querySelector(':scope > .tree-node-children') && nodeLi.classList.contains('collapsed')) {
            nodeLi.classList.remove('collapsed');
            toggler.textContent = EXPANDED_ICON;
        }
    });
}

/**
 * Collapses all expandable folders in the tree.
 */
function collapseAll() {
     log('info', "[Tree Logic] Collapsing all folders.");
     if (!fileTreeContainer) return;
     const togglers = fileTreeContainer.querySelectorAll('.tree-node.folder .toggler');
     togglers.forEach(toggler => {
        const nodeLi = toggler.closest('.tree-node.folder');
        // Check if it has children UL and is NOT currently collapsed
        if (nodeLi && nodeLi.querySelector(':scope > .tree-node-children') && !nodeLi.classList.contains('collapsed')) {
            nodeLi.classList.add('collapsed');
            toggler.textContent = COLLAPSED_ICON;
        }
    });
}

/**
 * Initializes the tree logic module.
 * Stores references to necessary elements and state, and attaches event listeners.
 * @param {object} config - Configuration object.
 * @param {HTMLElement} config.container - The file tree container element.
 * @param {object} config.initialSelectionState - Reference to the mutable selection state object.
 * @param {Array<object>} config.initialFileTreeData - Reference to the flat file tree data.
 * @param {Function} config.saveStateCallback - The function to call (debounced) to persist state.
 * @param {Function} config.onStateUpdate - Callback function to notify main module after state changes.
 * @returns {{ updateFolderStateCallback: Function }} - Returns an object containing the callback needed by the renderer.
 */
function initTreeLogic(config) {
    log('info', "[Tree Logic] Initializing...");
    if (!config || !config.container || !config.initialSelectionState || !config.initialFileTreeData || typeof config.saveStateCallback !== 'function' || typeof config.onStateUpdate !== 'function') {
        log('error', "[Tree Logic] Initialization failed: Invalid configuration provided.", config);
        throw new Error("Tree Logic initialization failed due to missing or invalid configuration.");
    }

    fileTreeContainer = config.container;
    selectionState = config.initialSelectionState; // Keep reference
    fileTreeData = config.initialFileTreeData; // Keep reference
    debouncedSaveCallback = () => debounce(config.saveStateCallback, CHECKBOX_DEBOUNCE_DELAY);
    afterStateUpdateCallback = config.onStateUpdate;


    // Remove existing listeners before adding new ones to prevent duplicates on refresh/re-init
    fileTreeContainer.removeEventListener('change', handleCheckboxChange);
    fileTreeContainer.removeEventListener('click', handleTreeClick);

    // Add new listeners using event delegation
    fileTreeContainer.addEventListener('change', handleCheckboxChange);
    fileTreeContainer.addEventListener('click', handleTreeClick);

    log('info', "[Tree Logic] Event listeners attached.");

    // Return the function needed by the renderer
    return {
        updateFolderStateCallback: updateFolderCheckboxState
    };
}

export {
    initTreeLogic,
    expandAll,
    collapseAll
    // updateFolderCheckboxState is not exported directly, it's returned by initTreeLogic
};

console.log("[Popup Tree Logic] Module loaded.");