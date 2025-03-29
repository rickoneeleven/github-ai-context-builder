// file path: popup/popup.js
import { getGitHubPat, getRepoSelectionState, setRepoSelectionState } from '../common/storage.js';
import { parseRepoUrl, getRepoTree, getFileContentBySha } from '../common/github_api.js';

console.log("[Popup] Script loading...");

// --- DOM Elements ---
const repoTitleElement = document.getElementById('repo-title');
const copyButton = document.getElementById('copy-button');
const refreshButton = document.getElementById('refresh-button');
const statusMessageElement = document.getElementById('status-message');
const errorMessageElement = document.getElementById('error-message');
const expandAllButton = document.getElementById('expand-all');
const collapseAllButton = document.getElementById('collapse-all');
const selectedCountElement = document.getElementById('selected-count');
const selectedSizeElement = document.getElementById('selected-size');
const fileTreeContainer = document.getElementById('file-tree-container');
const loadingIndicator = document.querySelector('.loading-indicator');
const perfStatsElement = document.getElementById('perf-stats');

// --- State Variables ---
let currentRepoUrl = null;
let currentOwner = null;
let currentRepo = null;
let fileTreeData = []; // Raw flat tree data from API { path, type, sha, size }
let treeHierarchy = {}; // Nested structure built for rendering
let selectionState = {}; // { 'path/to/file': true, 'path/to/folder/': false }
let isTruncated = false; // Flag if the repo tree from API was truncated
let totalSelectedFiles = 0;
let totalSelectedSize = 0;

// --- Initialization ---

/**
 * Initializes the popup by getting the current tab's URL and loading repository data.
 */
async function initializePopup() {
    console.log("[Popup] Initializing...");
    showStatus("Detecting GitHub repository...");
    perfStatsElement.textContent = ""; // Clear perf stats
    const startTime = performance.now();

    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0 || !tabs[0].url) {
            console.warn("[Popup] Could not get active tab info. Tabs:", tabs);
            throw new Error("Could not get active tab URL. Is a tab active in the current window?");
        }

        currentRepoUrl = tabs[0].url;
        console.log(`[Popup] Current URL: ${currentRepoUrl}`);

        // Clear previous state before parsing new URL
        clearMessages();
        fileTreeContainer.innerHTML = ''; // Clear tree
        repoTitleElement.textContent = 'Loading...';
        disableControls(); // Disable buttons while loading

        const repoInfo = parseRepoUrl(currentRepoUrl);
        if (!repoInfo) {
            throw new Error("URL does not look like a GitHub repository page. Cannot parse owner/repo.");
        }

        currentOwner = repoInfo.owner;
        currentRepo = repoInfo.repo;
        repoTitleElement.textContent = `${currentOwner}/${currentRepo}`;
        repoTitleElement.title = `${currentOwner}/${currentRepo}`; // Add tooltip

        await loadRepoData();

        const endTime = performance.now();
        perfStatsElement.textContent = `Load time: ${((endTime - startTime) / 1000).toFixed(2)}s`;
        // Re-enable refresh only after everything else is potentially enabled/disabled by loadRepoData
        refreshButton.disabled = false;

    } catch (error) {
        console.error("[Popup] Initialization failed:", error);
        // Log stack trace for detailed debugging
        console.error(error.stack);
        showError(`Initialization failed: ${error.message}`);
        repoTitleElement.textContent = "Error Loading";
        if(loadingIndicator) loadingIndicator.style.display = 'none'; // Hide loading
        disableControls(); // Ensure controls are disabled on init error
        refreshButton.disabled = false; // Still allow refresh on error
    }
}

/** Fetches repository tree data, loads selection state, and renders the file tree. */
async function loadRepoData() {
    console.log(`[Popup] Loading repository data for ${currentOwner}/${currentRepo}`);
    showStatus(`Fetching file tree for ${currentOwner}/${currentRepo}...`);
    if(loadingIndicator) loadingIndicator.style.display = 'block';
    fileTreeContainer.innerHTML = ''; // Clear previous tree
    fileTreeContainer.appendChild(loadingIndicator); // Add loading indicator
    disableControls(); // Disable controls during load

    // Reset state for this load attempt
    fileTreeData = [];
    treeHierarchy = {};
    selectionState = {};
    isTruncated = false;
    totalSelectedFiles = 0;
    totalSelectedSize = 0;
    updateSelectionInfo(); // Reflect reset state in UI

    try {
        // Fetch the tree structure - expecting { tree: Array, truncated: boolean }
        const repoTreeResult = await getRepoTree(currentOwner, currentRepo);

        // Assign tree and truncated status
        fileTreeData = repoTreeResult.tree;
        isTruncated = repoTreeResult.truncated;

        // Filter the extracted array
        fileTreeData = fileTreeData.filter(item => item.type === 'blob' || item.type === 'tree');
        console.log(`[Popup] Received and filtered ${fileTreeData.length} tree items. Truncated: ${isTruncated}`);

        if (fileTreeData.length === 0 && !isTruncated) { // Don't show "empty" if it was just truncated
           showStatus("Repository appears to be empty or inaccessible.", true);
           if(loadingIndicator) loadingIndicator.style.display = 'none';
           // Keep controls disabled except refresh
           refreshButton.disabled = false;
           return; // Nothing more to do
        }

        // Load persisted selection state or default to all checked
        const persistedState = await getRepoSelectionState(currentRepoUrl);
        if (persistedState) {
            console.log("[Popup] Loaded persisted selection state.");
            // Prune state: only keep keys that exist in the current fileTreeData
            const currentKeys = new Set(fileTreeData.map(item => item.type === 'tree' ? `${item.path}/` : item.path));
            selectionState = {};
            for (const key in persistedState) {
                if (currentKeys.has(key)) {
                    selectionState[key] = persistedState[key];
                } else {
                     console.log(`[Popup] Pruning stale key from loaded state: ${key}`);
                }
            }
             // Ensure all current items have *some* state (default to true if missing after prune)
            fileTreeData.forEach(item => {
                const key = item.type === 'tree' ? `${item.path}/` : item.path;
                if (selectionState[key] === undefined) {
                    console.log(`[Popup] Setting default 'true' for missing key after prune: ${key}`);
                    selectionState[key] = true; // Default to selected
                }
            });

        } else {
            console.log("[Popup] No persisted state found, defaulting to all selected.");
            selectionState = {};
            fileTreeData.forEach(item => {
                const key = item.type === 'tree' ? `${item.path}/` : item.path;
                selectionState[key] = true; // Default to selected
            });
        }

        // Build the hierarchical structure and render the tree
        renderFileTree(); // Renders based on selectionState

        // Calculate totals based on the loaded/default state BEFORE updating UI info
        calculateSelectedTotals();
        updateSelectionInfo(); // Updates counts, size, and button states (incl. copy)

        // Enable controls now that tree is loaded
        expandAllButton.disabled = fileTreeData.length === 0;
        collapseAllButton.disabled = fileTreeData.length === 0;
        // Copy button state is set inside updateSelectionInfo
        // Refresh button is enabled at the end of initializePopup or the catch block

        clearMessages(); // Clear "Loading..." message
        if (isTruncated) { // Check the flag
            showStatus("Warning: Repository tree is large and may be incomplete.", true);
        }

    } catch (error) {
        console.error("[Popup] Failed to load repository data:", error);
        // Log stack trace for detailed debugging
        console.error(error.stack);
        // Display the specific error message from the caught error
        showError(`Error loading data: ${error.message}. Check console for details.`);
        if(loadingIndicator) loadingIndicator.style.display = 'none';
        // Keep controls disabled except refresh
        disableControls();
        refreshButton.disabled = false;
    }
}


/** Disables primary action buttons, typically during loading or error states. */
function disableControls() {
    copyButton.disabled = true;
    expandAllButton.disabled = true;
    collapseAllButton.disabled = true;
    refreshButton.disabled = true; // Also disable refresh during intermediate states
}

// --- Helper Functions ---
/**
 * Finds all descendant paths (files and folders) for a given folder path within the flat fileTreeData.
 * @param {string} folderPathKey - The path key of the folder (e.g., "src/utils/"). Must end with '/'.
 * @returns {string[]} - An array of full path keys for all descendants.
 */
function getDescendantPaths(folderPathKey) {
    if (!folderPathKey.endsWith('/')) {
        console.warn("[Popup] getDescendantPaths called with non-folder path key:", folderPathKey);
        return [];
    }
    const descendants = [];
    // Remove trailing slash for path comparison
    const folderBasePath = folderPathKey.slice(0, -1);
    const pathPrefix = folderBasePath ? folderBasePath + '/' : ''; // Handle root folder ""

    for (const item of fileTreeData) {
        // Check if item.path starts with the folder's base path + '/'
        // Exclude the folder itself
        if (item.path.startsWith(pathPrefix) && item.path !== folderBasePath) {
             const key = item.type === 'tree' ? `${item.path}/` : item.path;
             descendants.push(key);
        }
    }
    return descendants;
}

/**
 * Finds the parent folder path key for a given path key.
 * @param {string} itemPathKey - The path key of the file or folder (e.g., "src/utils/helpers.js" or "src/utils/").
 * @returns {string | null} - The parent folder path key ending with '/', or null if it's a root item.
 */
function getParentFolderPath(itemPathKey) {
    // Remove trailing slash if it's a folder path key for processing
    const path = itemPathKey.endsWith('/') ? itemPathKey.slice(0, -1) : itemPathKey;
    const lastSlashIndex = path.lastIndexOf('/');

    if (lastSlashIndex === -1) {
        return null; // Root level item
    }
    // Return the part before the last slash, adding a trailing slash to mark it as a folder key
    return path.substring(0, lastSlashIndex) + '/';
}


// --- Calculation Function ---
/**
 * Recalculates the total number and size of selected files based on selectionState.
 * Updates the global totalSelectedFiles and totalSelectedSize variables.
 */
function calculateSelectedTotals() {
    console.log("[Popup] Calculating selected totals...");
    let count = 0;
    let size = 0;

    for (const pathKey in selectionState) {
        // Only count files (keys not ending in '/') that are checked (true)
        if (!pathKey.endsWith('/') && selectionState[pathKey] === true) {
            // Find the corresponding file data item using the exact pathKey
            const fileData = fileTreeData.find(item => item.path === pathKey && item.type === 'blob');
            if (fileData && typeof fileData.size === 'number') {
                count++;
                size += fileData.size;
            } else if (fileData) {
                console.warn(`[Popup] File data found for ${pathKey} but size is missing or invalid:`, fileData.size);
            } else {
                 console.warn(`[Popup] No file data found in fileTreeData for selected path key: ${pathKey}. State might be stale.`);
            }
        }
    }

    totalSelectedFiles = count;
    totalSelectedSize = size;
    console.log(`[Popup] Calculation complete: ${totalSelectedFiles} files, ${formatBytes(totalSelectedSize)}`);
}

// --- UI Update Functions ---
/**
 * Displays a status message to the user. Clears error message.
 * @param {string} message The message to display.
 * @param {boolean} [isWarning=false] If true, uses error styling but it's just a status.
 */
function showStatus(message, isWarning = false) {
    console.log(`[Popup Status] ${message}`);
    errorMessageElement.classList.add('hidden'); // Hide error
    errorMessageElement.textContent = '';
    statusMessageElement.textContent = message;
    // Use classList to add/remove classes cleanly
    statusMessageElement.classList.remove('hidden', 'error', 'status'); // Remove all potentially existing classes
    statusMessageElement.classList.add(isWarning ? 'error' : 'status'); // Add the correct class
}

/**
 * Displays an error message to the user. Clears status message.
 * @param {string} message The error message to display.
 */
function showError(message) {
    console.error(`[Popup Error] ${message}`);
    statusMessageElement.classList.add('hidden'); // Hide status
    statusMessageElement.textContent = '';
    errorMessageElement.textContent = message;
    errorMessageElement.classList.remove('hidden'); // Show error
}

/** Clears any currently displayed status or error messages. */
function clearMessages() {
    statusMessageElement.classList.add('hidden');
    errorMessageElement.classList.add('hidden');
    statusMessageElement.textContent = '';
    errorMessageElement.textContent = '';
}

/**
 * Updates the display of selected file count and total size.
 * Assumes calculateSelectedTotals() has been called before this.
 * Also enables/disables the Copy button based on selection count.
 */
function updateSelectionInfo() {
    selectedCountElement.textContent = `Selected: ${totalSelectedFiles} files`;
    selectedSizeElement.textContent = `Total Size: ${formatBytes(totalSelectedSize)}`;
    // Enable copy button only if > 0 files are selected
    copyButton.disabled = (totalSelectedFiles === 0);
    console.log(`[Popup] UI selection info updated: ${totalSelectedFiles} files, ${formatBytes(totalSelectedSize)}. Copy button disabled: ${copyButton.disabled}`);
}

/**
 * Formats bytes into a human-readable string (B, KB, MB, GB).
 * @param {number | null | undefined} bytes The number of bytes.
 * @param {number} [decimals=2] The number of decimal places.
 * @returns {string} Formatted string.
 */
function formatBytes(bytes, decimals = 2) {
    // Handle null/undefined/zero bytes robustly
    if (bytes == null || bytes <= 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']; // Added more sizes
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    // Ensure index is within bounds of sizes array, handle potential edge cases like very large numbers
    const index = Math.max(0, Math.min(i, sizes.length - 1));
    return parseFloat((bytes / Math.pow(k, index)).toFixed(dm)) + ' ' + sizes[index];
}


// --- Core Rendering Logic ---
/**
 * Builds the hierarchical tree structure from the flat API data.
 * @returns {object} A nested object representing the file tree.
 */
function buildTreeHierarchy(items) {
    const tree = {};
    // Sort items alphabetically by path for consistent order before building
    items.sort((a, b) => a.path.localeCompare(b.path));

    for (const item of items) {
        const parts = item.path.split('/');
        let currentLevel = tree;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLastPart = i === parts.length - 1;
            const currentPathSegment = parts.slice(0, i + 1).join('/');

            if (!currentLevel[part]) {
                if (isLastPart) {
                    currentLevel[part] = {
                        __data: item,
                        __children: item.type === 'tree' ? {} : null
                    };
                } else {
                     currentLevel[part] = {
                         __data: { path: currentPathSegment, type: 'tree', sha: null, size: null },
                         __children: {}
                     };
                }
            } else {
                 if (isLastPart) {
                     currentLevel[part].__data = item;
                     if (item.type === 'tree' && !currentLevel[part].__children) {
                          console.warn(`[Popup] Adding missing __children during update for explicit folder: ${part}`);
                          currentLevel[part].__children = {};
                     } else if (item.type === 'blob') {
                         currentLevel[part].__children = null;
                     }
                 } else if (!currentLevel[part].__children) {
                      console.warn(`[Popup] Adding missing __children to existing intermediate node: ${part}`);
                      currentLevel[part].__children = {};
                      if (!currentLevel[part].__data || currentLevel[part].__data.type !== 'tree') {
                          currentLevel[part].__data = { ...(currentLevel[part].__data || {}), path: currentPathSegment, type: 'tree' };
                      }
                 }
            }

            if (currentLevel[part].__children) {
                 currentLevel = currentLevel[part].__children;
            } else if (!isLastPart) {
                 console.error(`[Popup] Tree building error: Expected folder at '${part}' for path '${item.path}', but found non-folder node.`);
                 break;
            }
        }
    }
    return tree;
}


/** Renders the file tree HTML based on the hierarchical data. */
function renderFileTree() {
    console.log("[Popup] Rendering file tree...");
    if(loadingIndicator) loadingIndicator.style.display = 'none';
    fileTreeContainer.innerHTML = ''; // Clear previous content or loading indicator

    treeHierarchy = buildTreeHierarchy(fileTreeData);

    const rootElement = document.createElement('ul');
    rootElement.className = 'tree-root';
    rootElement.style.paddingLeft = '0'; // Remove default UL padding
    rootElement.style.listStyle = 'none'; // Remove default UL bullets

    // Start recursion from the root level
    createTreeNodesRecursive(treeHierarchy, rootElement);

    fileTreeContainer.appendChild(rootElement);
    console.log("[Popup] File tree rendering complete.");

    addTreeEventListeners(); // Add listeners AFTER rendering
}

/**
 * Recursively creates HTML elements for the file tree.
 * Uses Unicode escapes for icons.
 * @param {object} node Current level in the treeHierarchy.
 * @param {HTMLElement} parentElement The parent UL element to append to.
 */
function createTreeNodesRecursive(node, parentElement) {
    const keys = Object.keys(node).sort((a, b) => {
        const nodeA = node[a];
        const nodeB = node[b];
        const typeA = nodeA.__data?.type === 'tree' ? 0 : 1;
        const typeB = nodeB.__data?.type === 'tree' ? 0 : 1;
        if (typeA !== typeB) return typeA - typeB;
        return a.localeCompare(b);
    });

    for (const key of keys) {
        const itemNode = node[key];
        if (!itemNode.__data) {
             console.warn(`[Popup] Skipping node render, missing __data for key: ${key}`);
             continue;
        }
        const itemData = itemNode.__data;
        const itemPath = itemData.path;
        const isFolder = itemData.type === 'tree';
        const nodeKey = isFolder ? `${itemPath}/` : itemPath;

        const li = document.createElement('li');
        li.className = `tree-node ${isFolder ? 'folder' : 'file'}`;
        if (isFolder) {
            li.classList.add('collapsed');
        }
        li.dataset.path = nodeKey;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        const safeId = `cb_${nodeKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        checkbox.id = safeId;
        checkbox.dataset.path = nodeKey;

        const currentState = selectionState[nodeKey];
        if (isFolder) {
            const descendants = getDescendantPaths(nodeKey);
            const childrenStates = descendants.map(p => selectionState[p]).filter(state => state !== undefined);
            if (childrenStates.length > 0) {
                const allChecked = childrenStates.every(state => state === true);
                const noneChecked = childrenStates.every(state => state === false);
                if (allChecked) {
                    checkbox.checked = true;
                    checkbox.indeterminate = false;
                    selectionState[nodeKey] = true;
                } else if (noneChecked) {
                    checkbox.checked = false;
                    checkbox.indeterminate = false;
                    selectionState[nodeKey] = false;
                } else {
                    checkbox.checked = false;
                    checkbox.indeterminate = true;
                    selectionState[nodeKey] = false;
                }
            } else {
                 checkbox.checked = currentState === true;
                 checkbox.indeterminate = false;
                 selectionState[nodeKey] = checkbox.checked;
            }
        } else {
            checkbox.checked = currentState === true;
            checkbox.indeterminate = false;
        }

        const label = document.createElement('label');
        label.htmlFor = safeId;

        const hasChildren = isFolder && itemNode.__children && Object.keys(itemNode.__children).length > 0;
        const toggler = document.createElement('span');
        toggler.className = 'toggler';
        if (hasChildren) {
            toggler.textContent = '\u25B6'; // ▶ (Unicode escape)
            toggler.title = "Expand/Collapse";
        } else {
             toggler.innerHTML = ' '; // Keep alignment using non-breaking space
             if(isFolder) li.classList.remove('collapsed'); // Ensure empty folders aren't styled as collapsed
        }
        label.appendChild(toggler);

        const icon = document.createElement('span');
        icon.className = 'node-icon';
        icon.textContent = isFolder ? '\u{1F4C1}' : '\u{1F4C4}'; // 📁 : 📄 (ES6 Unicode escapes)
        label.appendChild(icon);

        const nameSpan = document.createElement('span');
        nameSpan.className = 'node-name';
        nameSpan.textContent = key;
        nameSpan.title = itemPath;
        label.appendChild(nameSpan);

        const metaSpan = document.createElement('span');
        metaSpan.className = 'node-meta';
        if (!isFolder && itemData.size != null) {
            metaSpan.textContent = formatBytes(itemData.size);
        }
        label.appendChild(metaSpan);

        li.appendChild(checkbox);
        li.appendChild(label);
        parentElement.appendChild(li);

        if (hasChildren) {
            const childrenUl = document.createElement('ul');
            childrenUl.className = 'tree-node-children';
            li.appendChild(childrenUl);
            createTreeNodesRecursive(itemNode.__children, childrenUl);
        }
    }
}

/** Adds event listeners to the dynamically generated tree using event delegation. */
function addTreeEventListeners() {
     console.log("[Popup] Adding tree event listeners...");
     // Remove existing listeners before adding new ones to prevent duplicates on refresh
     fileTreeContainer.removeEventListener('change', handleCheckboxChange);
     fileTreeContainer.removeEventListener('click', handleTreeClick);
     // Add new listeners
     fileTreeContainer.addEventListener('change', handleCheckboxChange);
     fileTreeContainer.addEventListener('click', handleTreeClick);
     console.log("[Popup] Tree event listeners added.");
}

// --- Event Handlers ---
/**
 * Handles checkbox changes in the file tree. Updates selection state,
 * propagates changes, persists state, and updates UI.
 * @param {Event} event - The change event object.
 */
async function handleCheckboxChange(event) {
    if (event.target.type !== 'checkbox' || !event.target.dataset.path) return;

    const checkbox = event.target;
    const pathKey = checkbox.dataset.path;
    const isChecked = checkbox.checked;

    console.log(`[Popup] Checkbox changed: ${pathKey}, New Checked State: ${isChecked}, Was Indeterminate: ${checkbox.indeterminate}`);

    // If checkbox was indeterminate, clicking it should make it checked.
    // Ensure indeterminate state is cleared when manually changed.
    if (checkbox.indeterminate) {
        checkbox.indeterminate = false;
        // If it was indeterminate, clicking it means the user wants it checked now
        // checkbox.checked = true; // The browser might already do this, but explicit is okay. Let's rely on the browser's `isChecked` which reflects the click.
    }

    selectionState[pathKey] = isChecked; // Update state based on the final checked status

    const isFolder = pathKey.endsWith('/');
    if (isFolder) {
        // When a folder checkbox is explicitly changed, propagate to all descendants
        const descendants = getDescendantPaths(pathKey);
        descendants.forEach(descendantPathKey => {
            if (selectionState[descendantPathKey] !== isChecked) {
                 selectionState[descendantPathKey] = isChecked;
            }
            // Update descendant checkboxes visually
            const descendantCheckbox = fileTreeContainer.querySelector(`input[type="checkbox"][data-path="${CSS.escape(descendantPathKey)}"]`);
            if (descendantCheckbox) {
                descendantCheckbox.checked = isChecked;
                descendantCheckbox.indeterminate = false; // Descendants reflect the parent's explicit state
            }
        });
        console.log(`[Popup] Propagated check state (${isChecked}) to ${descendants.length} descendants of ${pathKey}`);
    }

    // Update parent folder states based on children states (upwards propagation)
    let parentPathKey = getParentFolderPath(pathKey);
    while (parentPathKey) {
        const parentCheckbox = fileTreeContainer.querySelector(`input[type="checkbox"][data-path="${CSS.escape(parentPathKey)}"]`);
        if (!parentCheckbox) {
             console.warn(`[Popup] Could not find parent checkbox DOM element for path: ${parentPathKey}`);
             break; // Stop propagation if parent DOM element is missing
        }

        // Find direct children of this parent
        const directChildrenKeys = Object.keys(selectionState).filter(k => getParentFolderPath(k) === parentPathKey);

        if (directChildrenKeys.length === 0) {
             // If a folder has no children (or they aren't in selectionState), its state is determined solely by its own checkbox
             console.warn(`[Popup] Parent folder ${parentPathKey} has no tracked children. Its state is its own.`);
             selectionState[parentPathKey] = parentCheckbox.checked; // Reflect its own checkbox state
             parentCheckbox.indeterminate = false;
        } else {
            // Check the state of all direct children
            const childrenStates = directChildrenKeys.map(k => selectionState[k]); // Get state from selectionState
            const allChecked = childrenStates.every(state => state === true);
            const noneChecked = childrenStates.every(state => state === false);

            if (allChecked) {
                 selectionState[parentPathKey] = true;
                 parentCheckbox.checked = true;
                 parentCheckbox.indeterminate = false;
                 console.log(`[Popup] Parent folder ${parentPathKey} set to checked (all children checked).`);
            } else if (noneChecked) {
                selectionState[parentPathKey] = false;
                parentCheckbox.checked = false;
                parentCheckbox.indeterminate = false;
                 console.log(`[Popup] Parent folder ${parentPathKey} set to unchecked (all children unchecked).`);
            } else {
                 // Mixed states among children
                 selectionState[parentPathKey] = false; // Treat indeterminate as 'not fully selected' in state
                 parentCheckbox.checked = false;
                 parentCheckbox.indeterminate = true;
                 console.log(`[Popup] Parent folder ${parentPathKey} set to indeterminate (mixed children states).`);
            }
        }
        // Move to the next parent up
        parentPathKey = getParentFolderPath(parentPathKey);
    }

    // Recalculate totals and update UI display
    calculateSelectedTotals();
    updateSelectionInfo();

    // Persist the updated selection state
    try {
        console.log("[Popup] Persisting updated selection state...");
        const success = await setRepoSelectionState(currentRepoUrl, selectionState);
        if (!success) {
            console.error("[Popup] Failed to persist selection state.");
            // Show a temporary warning
            showStatus("Warning: Could not save selection state.", true);
            setTimeout(clearMessages, 3000);
        } else {
             console.log("[Popup] Selection state persisted successfully.");
        }
    } catch (error) {
        console.error("[Popup] Error persisting selection state:", error);
        // Log stack trace for detailed debugging
        console.error(error.stack);
         // Show a temporary warning
         showStatus("Warning: Error saving selection state.", true);
         setTimeout(clearMessages, 3000);
    }
}


/**
 * Handles clicks within the tree container, specifically for toggling folders.
 * Uses Unicode escapes for icons.
 * Stops event propagation if the click is specifically on the toggler element
 * to prevent interference with the checkbox state.
 * @param {Event} event - The click event object.
 */
function handleTreeClick(event) {
    // Find the toggler span that was clicked, if any
    const toggler = event.target.closest('.toggler');

    // Proceed only if a toggler was clicked AND it's within a folder node
    if (toggler && toggler.closest('.tree-node.folder')) {
        const nodeLi = toggler.closest('.tree-node.folder');
        const childrenUl = nodeLi.querySelector('.tree-node-children');

        if (nodeLi && childrenUl) {
             console.log(`[Popup] Toggler clicked for: ${nodeLi.dataset.path}`);
            const isCollapsed = nodeLi.classList.toggle('collapsed');
            toggler.textContent = isCollapsed ? '\u25B6' : '\u25BC'; // ▶ : ▼ (Unicode escapes)

            // *** ADDED: Stop propagation ***
            // Prevent this click from bubbling up to the label, which could
            // trigger the checkbox 'change' event inappropriately via the label's 'for'.
            event.stopPropagation();
            console.log(`[Popup] Stopped event propagation for toggler click on ${nodeLi.dataset.path}`);
        }
    }
    // If the click was not on a toggler (e.g., elsewhere on the label or node),
    // let the event proceed normally (e.g., to toggle the checkbox via the label's 'for' attribute, which triggers the 'change' event handled by handleCheckboxChange).
}


// --- Action Button Handlers ---

/**
 * Fetches the context prefix string from the assets file.
 * Includes robust error handling.
 * @returns {Promise<string>} The prefix string (with trailing newlines) or an empty string if fetch fails.
 */
async function getContextPrefix() {
    const prefixFilePath = 'assets/context_prefix.txt';
    try {
        const prefixUrl = chrome.runtime.getURL(prefixFilePath);
        console.log(`[Popup] Fetching context prefix from: ${prefixUrl}`);
        const response = await fetch(prefixUrl);
        if (!response.ok) {
            // Log the status text for more context on the error
            throw new Error(`Failed to fetch prefix file at ${prefixFilePath}: ${response.status} ${response.statusText}`);
        }
        const prefixText = await response.text();
        console.log("[Popup] Successfully fetched context prefix.");
        // Ensure consistent formatting with trailing newlines
        return prefixText.trimEnd() + '\n\n';
    } catch (error) {
        console.error(`[Popup] Error fetching context prefix:`, error);
        // Log stack trace for detailed debugging
        console.error(error.stack);
        // Display error to the user
        showError(`Error loading context prefix: ${error.message}. Check console and ensure '${prefixFilePath}' exists.`);
        return ""; // Return empty string on failure
    }
}


/** Handles the click on the "Copy Context" button. Fetches prefix and selected file contents. */
async function handleCopyClick() {
    console.log("[Popup] Copy button clicked.");
    if (copyButton.disabled) {
        console.warn("[Popup] Copy button clicked while disabled.");
        return;
    }

    disableControls();
    refreshButton.disabled = false; // Keep refresh active
    const originalButtonHTML = copyButton.innerHTML;
    // MODIFIED: Use the same refresh icon entity (↻) for the "Copying..." state
    copyButton.innerHTML = `<span class="icon">↻</span> Copying...`;
    clearMessages();
    showStatus("Preparing context...");

    // Fetch the prefix first
    const contextPrefix = await getContextPrefix();
    // No need to bail here if prefix fetch failed, getContextPrefix shows error and returns ""

    showStatus("Preparing list of files to fetch...");
    const selectedFilesToFetch = [];
    for (const pathKey in selectionState) {
        if (selectionState[pathKey] === true && !pathKey.endsWith('/')) {
            const fileData = fileTreeData.find(item => item.path === pathKey && item.type === 'blob');
            if (fileData && fileData.sha) {
                selectedFilesToFetch.push({ path: fileData.path, sha: fileData.sha });
            } else {
                 console.warn(`[Popup] Could not find SHA for selected file: ${pathKey}. Skipping.`);
            }
        }
    }

     console.log(`[Popup] Found ${selectedFilesToFetch.length} selected files with SHAs.`);

     if (selectedFilesToFetch.length === 0) {
         showError("No files selected to copy.");
         // Reset button HTML to original (which uses HTML entities now)
         copyButton.innerHTML = originalButtonHTML;
         copyButton.disabled = true;
         expandAllButton.disabled = fileTreeData.length === 0;
         collapseAllButton.disabled = fileTreeData.length === 0;
         refreshButton.disabled = false;
         return;
     }

    let formattedContext = "";
    let filesProcessed = 0;
    let fetchErrors = 0;
    const totalToFetch = selectedFilesToFetch.length;
    const startTime = performance.now();
    showStatus(`Fetching content for ${totalToFetch} files... (0/${totalToFetch})`);

    try {
        // Sort files alphabetically by path before fetching and formatting
        selectedFilesToFetch.sort((a, b) => a.path.localeCompare(b.path));

        const contentPromises = selectedFilesToFetch.map(file =>
            getFileContentBySha(currentOwner, currentRepo, file.sha)
                .then(content => {
                    filesProcessed++;
                    if (filesProcessed % 5 === 0 || filesProcessed === totalToFetch) {
                        showStatus(`Fetching file contents... (${filesProcessed}/${totalToFetch})`);
                    }
                    return { path: file.path, content: content };
                })
                .catch(error => {
                    console.error(`[Popup] Failed to fetch content for ${file.path} (SHA: ${file.sha}):`, error);
                    // Log stack trace for detailed debugging
                    console.error(error.stack);
                    fetchErrors++;
                    filesProcessed++;
                     if (filesProcessed % 5 === 0 || filesProcessed === totalToFetch) {
                        showStatus(`Fetching file contents... (${filesProcessed}/${totalToFetch})`);
                    }
                    // Return an object indicating error, useful for Promise.all
                    return { path: file.path, error: error.message || "Unknown error" };
                })
        );

        const results = await Promise.all(contentPromises);
        const endTime = performance.now();
        console.log(`[Popup] Content fetching completed in ${((endTime - startTime) / 1000).toFixed(2)}s.`);

        showStatus("Formatting context...");

        // Build the final context string
        formattedContext = contextPrefix; // Start with the prefix
        results.forEach(result => {
            if (result.content !== undefined) {
                // Sanitize null bytes which can cause issues with clipboard/display
                const sanitizedContent = result.content.replace(/\0/g, '');
                formattedContext += `// file path: ${result.path}\n`;
                formattedContext += `${sanitizedContent}\n\n`;
            } else {
                 console.warn(`[Popup] Skipping file in final output due to fetch error: ${result.path}`);
                 // Optionally add a note about the failed file in the context?
                 // formattedContext += `// ERROR: Failed to fetch content for file path: ${result.path}\n// Error: ${result.error}\n\n`;
            }
        });

        // Remove trailing whitespace/newlines from the final string
        formattedContext = formattedContext.trimEnd();

        const filesCopied = totalToFetch - fetchErrors;
        let finalMessage;
        let messageIsWarning = false;

        // Determine the final status message
        if (filesCopied > 0) {
            finalMessage = `Context for ${filesCopied} file(s) copied!`;
            if (fetchErrors > 0) {
                finalMessage += ` (${fetchErrors} failed)`;
                messageIsWarning = true; // Indicate partial success as a warning
            }
        } else if (fetchErrors > 0) {
            finalMessage = `Copy failed: Could not retrieve content for any of the ${fetchErrors} selected file(s).`;
            messageIsWarning = true; // Treat total failure as an error/warning
        } else {
             // This case should ideally not happen if selectedFilesToFetch > 0
            finalMessage = "Copy failed: No content generated.";
            messageIsWarning = true;
        }

        // Only attempt to copy if there's actually something to copy
        if (formattedContext.trim()) {
             await navigator.clipboard.writeText(formattedContext);
             console.log("[Popup] Formatted context copied to clipboard.");
             showStatus(finalMessage, messageIsWarning); // Show success/partial success message
        } else {
             // If formattedContext is empty (prefix fetch failed AND all file fetches failed or no files selected)
             console.log("[Popup] Nothing to copy to clipboard (formatted context is empty).");
             // Show an appropriate error message based on why it might be empty
             if (!contextPrefix && selectedFilesToFetch.length === 0) {
                 showError("Copy failed: No prefix loaded and no files selected.");
             } else if (fetchErrors === totalToFetch && totalToFetch > 0) {
                 showError(finalMessage); // Show the "Could not retrieve content..." message
             } else {
                 showError("Copy failed: Nothing generated to copy."); // Generic fallback
             }
        }

        // System notification (check permission first)
        try {
            // Use Permissions API for checking if available, fallback to basic check
            let hasPermission = false;
            if (chrome.permissions?.contains) {
                hasPermission = await chrome.permissions.contains({ permissions: ['notifications'] });
            } else {
                 // Fallback check (might not be reliable in all contexts)
                 console.warn("[Popup] chrome.permissions.contains API not available, attempting basic check.");
                 // Basic check - assume granted if API exists, but this isn't robust.
                 // Ideally, prompt for permission if needed, but that's more complex.
                 hasPermission = !!chrome.notifications;
            }

            if(hasPermission) {
                 chrome.notifications.create({
                     type: 'basic',
                     iconUrl: chrome.runtime.getURL('icons/icon48.png'), // Ensure icons are defined in manifest.json 'web_accessible_resources' if needed
                     title: 'GitHub AI Context Builder',
                     message: finalMessage // Use the same message shown in the popup
                 });
            } else {
                console.log("[Popup] Notification permission not granted or check failed, skipping notification.");
            }
        } catch (notifyError) {
             console.warn("[Popup] Could not create notification:", notifyError);
             console.warn(notifyError.stack); // Log stack trace
        }

    } catch (error) {
        console.error("[Popup] Error during copy process:", error);
        // Log stack trace for detailed debugging
        console.error(error.stack);
        showError(`Copy failed unexpectedly: ${error.message}`);
    } finally {
        // Reset button HTML to original state
        copyButton.innerHTML = originalButtonHTML;
        // Re-enable buttons based on current state (e.g., if files are still selected)
        copyButton.disabled = totalSelectedFiles === 0; // Re-evaluate based on potentially changed state
        expandAllButton.disabled = fileTreeData.length === 0;
        collapseAllButton.disabled = fileTreeData.length === 0;
        refreshButton.disabled = false; // Always re-enable refresh
    }
}

/** Handles the click on the "Refresh" button. */
function handleRefreshClick() {
    console.log("[Popup] Refresh button clicked.");
    clearMessages();
    fileTreeContainer.innerHTML = ''; // Clear the tree display immediately
    repoTitleElement.textContent = "Refreshing...";
    disableControls(); // Disable controls while refreshing

    // Reset internal state variables
    selectionState = {};
    fileTreeData = [];
    treeHierarchy = {};
    totalSelectedFiles = 0;
    totalSelectedSize = 0;
    isTruncated = false;
    updateSelectionInfo(); // Update UI to reflect reset state

    // Re-initialize the popup, which will fetch fresh data
    initializePopup();
}

/** Handles the click on the "Expand All" button. */
function handleExpandAll() {
    console.log("[Popup] Expand All clicked.");
    const togglers = fileTreeContainer.querySelectorAll('.tree-node.folder .toggler');
    togglers.forEach(toggler => {
        const nodeLi = toggler.closest('.tree-node.folder');
        // Check if it has children and is currently collapsed
        if (nodeLi && nodeLi.querySelector('.tree-node-children') && nodeLi.classList.contains('collapsed')) {
            nodeLi.classList.remove('collapsed');
            toggler.textContent = '\u25BC'; // ▼ (Unicode escape) - Expanded state icon
        }
    });
}

/** Handles the click on the "Collapse All" button. */
function handleCollapseAll() {
     console.log("[Popup] Collapse All clicked.");
     const togglers = fileTreeContainer.querySelectorAll('.tree-node.folder .toggler');
     togglers.forEach(toggler => {
        const nodeLi = toggler.closest('.tree-node.folder');
        // Check if it has children and is not currently collapsed
        if (nodeLi && nodeLi.querySelector('.tree-node-children') && !nodeLi.classList.contains('collapsed')) {
            nodeLi.classList.add('collapsed');
            toggler.textContent = '\u25B6'; // ▶ (Unicode escape) - Collapsed state icon
        }
    });
}


// --- Attach Event Listeners ---
// Use DOMContentLoaded to ensure the DOM is ready before trying to initialize
document.addEventListener('DOMContentLoaded', initializePopup);
// Attach listeners for buttons
copyButton.addEventListener('click', handleCopyClick);
refreshButton.addEventListener('click', handleRefreshClick);
expandAllButton.addEventListener('click', handleExpandAll);
collapseAllButton.addEventListener('click', handleCollapseAll);
// Tree listeners (for checkboxes and togglers) are attached dynamically
// after the tree is rendered by calling addTreeEventListeners() within renderFileTree().

console.log("[Popup] Script loaded and essential listeners attached.");