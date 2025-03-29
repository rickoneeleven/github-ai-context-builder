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
            // Log the tabs object for debugging if needed
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

        // *** MODIFIED: Assign tree and truncated status ***
        fileTreeData = repoTreeResult.tree;
        isTruncated = repoTreeResult.truncated;
        // *** END MODIFICATION ***

        // Now filter the extracted array
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
    // console.log(`[Popup] Descendants for ${folderPathKey}:`, descendants); // Verbose
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
                 // This can happen if the state got desynced, but pruning logic should minimize this
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
    // Ensures folders appear before files within the same directory level during iteration
    items.sort((a, b) => a.path.localeCompare(b.path));

    for (const item of items) {
        const parts = item.path.split('/');
        let currentLevel = tree;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLastPart = i === parts.length - 1;
            // Construct the path segment for potential implicit folder creation
            const currentPathSegment = parts.slice(0, i + 1).join('/');

            if (!currentLevel[part]) {
                // Node doesn't exist, create it
                if (isLastPart) {
                    // It's the actual item (file or explicit folder from API)
                    currentLevel[part] = {
                        __data: item,
                        __children: item.type === 'tree' ? {} : null // Only folders have children objects
                    };
                } else {
                    // It's an intermediate path segment, create an implicit folder node
                     console.warn(`[Popup] Creating implicit folder node for: ${part} in path ${item.path}`);
                     // Synthesize minimal folder data
                     currentLevel[part] = {
                         __data: { path: currentPathSegment, type: 'tree', sha: null, size: null }, // Use reconstructed path, mark as tree
                         __children: {}
                     };
                }
            } else {
                 // Node already exists (might be an implicit folder created earlier)
                 if (isLastPart) {
                     // If this item from the API corresponds to an existing (potentially implicit) node,
                     // update its __data with the actual item data from the API.
                     // Ensure it keeps its children if it was already treated as a folder.
                     currentLevel[part].__data = item;
                     if (item.type === 'tree' && !currentLevel[part].__children) {
                          console.warn(`[Popup] Adding missing __children during update for explicit folder: ${part}`);
                          currentLevel[part].__children = {}; // Ensure folder has children object
                     } else if (item.type === 'blob') {
                         currentLevel[part].__children = null; // Ensure files don't have children object
                     }
                 } else if (!currentLevel[part].__children) {
                      // This existing node should represent a folder because we have more path parts,
                      // but it doesn't have a __children object. This implies it might have been
                      // incorrectly treated as a file before, or data is inconsistent. Fix it.
                      console.warn(`[Popup] Adding missing __children to existing intermediate node: ${part}`);
                      currentLevel[part].__children = {};
                      // Ensure it's marked as type 'tree' if it wasn't already
                      if (!currentLevel[part].__data || currentLevel[part].__data.type !== 'tree') {
                          currentLevel[part].__data = { ...(currentLevel[part].__data || {}), path: currentPathSegment, type: 'tree' };
                      }
                 }
            }

            // Move to the next level for the next iteration, only if it's a folder
            if (currentLevel[part].__children) {
                 currentLevel = currentLevel[part].__children;
            } else if (!isLastPart) {
                 // If we expect more parts but landed on a node without __children, something is wrong.
                 console.error(`[Popup] Tree building error: Expected folder at '${part}' for path '${item.path}', but found non-folder node.`);
                 // Avoid crashing, break inner loop for this item
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
 * @param {object} node Current level in the treeHierarchy.
 * @param {HTMLElement} parentElement The parent UL element to append to.
 */
function createTreeNodesRecursive(node, parentElement) {
    // Sort keys to ensure consistent order (folders first, then alpha)
    const keys = Object.keys(node).sort((a, b) => {
        const nodeA = node[a];
        const nodeB = node[b];
        // Ensure __data exists before accessing type
        const typeA = nodeA.__data?.type === 'tree' ? 0 : 1;
        const typeB = nodeB.__data?.type === 'tree' ? 0 : 1;
        if (typeA !== typeB) return typeA - typeB; // Folders first
        return a.localeCompare(b); // Then alphanumeric
    });

    for (const key of keys) {
        const itemNode = node[key];
        // Skip if data is somehow missing (buildTreeHierarchy tries to prevent this)
        if (!itemNode.__data) {
             console.warn(`[Popup] Skipping node render, missing __data for key: ${key}`);
             continue;
        }
        const itemData = itemNode.__data; // { path, type, sha, size }
        const itemPath = itemData.path; // Full path from API data
        const isFolder = itemData.type === 'tree';
        // Use path key format (trailing slash for folders) for state management and element identification
        const nodeKey = isFolder ? `${itemPath}/` : itemPath;

        const li = document.createElement('li');
        li.className = `tree-node ${isFolder ? 'folder' : 'file'}`;
        if (isFolder) {
            li.classList.add('collapsed'); // Default folders to collapsed state
        }
        li.dataset.path = nodeKey; // Store the unique path key

        // --- Checkbox ---
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        // Create a relatively safe ID for the label's 'for' attribute
        const safeId = `cb_${nodeKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        checkbox.id = safeId;
        checkbox.dataset.path = nodeKey; // Link checkbox action to the path key

        // Set initial checked/indeterminate state based on loaded selectionState
        const currentState = selectionState[nodeKey];
        if (isFolder) {
            // Determine folder state based on children (after loading state)
            const descendants = getDescendantPaths(nodeKey);
            // Filter out descendants that might not be in selectionState (shouldn't happen with pruning/defaulting logic, but safer)
            const childrenStates = descendants.map(p => selectionState[p]).filter(state => state !== undefined);

            if (childrenStates.length > 0) { // Only calculate if folder has known children
                const allChecked = childrenStates.every(state => state === true);
                const noneChecked = childrenStates.every(state => state === false); // Note: indeterminate children count as 'not all checked' and 'not none checked'

                if (allChecked) {
                    checkbox.checked = true;
                    checkbox.indeterminate = false;
                    selectionState[nodeKey] = true; // Ensure state reflects reality
                } else if (noneChecked) {
                    checkbox.checked = false;
                    checkbox.indeterminate = false;
                    selectionState[nodeKey] = false; // Ensure state reflects reality
                } else {
                    // Mixed states among children
                    checkbox.checked = false; // Indeterminate should visually appear unchecked
                    checkbox.indeterminate = true;
                    selectionState[nodeKey] = false; // Store 'false' in state for indeterminate folders
                }
            } else {
                 // Folder has no descendants in the filtered tree (or is empty)
                 // Default to its own loaded state, or true if it was missing (handled in loadRepoData)
                 checkbox.checked = currentState === true;
                 checkbox.indeterminate = false;
                 selectionState[nodeKey] = checkbox.checked; // Ensure state matches
            }

        } else {
            // File: state is simpler
            checkbox.checked = currentState === true;
            checkbox.indeterminate = false; // Files are never indeterminate
        }


        // --- Label ---
        const label = document.createElement('label');
        label.htmlFor = safeId; // Associate label with checkbox for accessibility/click handling

        // Toggler (only for folders with children)
        const hasChildren = isFolder && itemNode.__children && Object.keys(itemNode.__children).length > 0;
        const toggler = document.createElement('span');
        toggler.className = 'toggler';
        if (hasChildren) {
            toggler.textContent = '▶'; // Collapsed indicator ('▸' or similar)
            toggler.title = "Expand/Collapse";
        } else {
            // Keep structure consistent, add a non-breaking space for alignment
             toggler.innerHTML = ' ';
             // Ensure non-expandable folders don't get the collapsed class styling
             if(isFolder) li.classList.remove('collapsed');
        }
        label.appendChild(toggler);

        // Icon
        const icon = document.createElement('span');
        icon.className = 'node-icon';
        icon.textContent = isFolder ? '📁' : '📄'; // Unicode icons ('📂' for open folder?)
        label.appendChild(icon);

        // Name
        const nameSpan = document.createElement('span');
        nameSpan.className = 'node-name';
        nameSpan.textContent = key; // The last part of the path (file/folder name)
        nameSpan.title = itemPath; // Show full path on hover
        label.appendChild(nameSpan);

        // Meta (Size for files)
        const metaSpan = document.createElement('span');
        metaSpan.className = 'node-meta';
        if (!isFolder && itemData.size != null) { // Check for null/undefined size
            metaSpan.textContent = formatBytes(itemData.size);
        }
        label.appendChild(metaSpan);

        // Assemble the list item
        li.appendChild(checkbox);
        li.appendChild(label);
        parentElement.appendChild(li);

        // --- Children ---
        if (hasChildren) {
            const childrenUl = document.createElement('ul');
            childrenUl.className = 'tree-node-children';
            // Indentation and styling are handled by CSS based on .tree-node-children
            li.appendChild(childrenUl);
            // Recurse for children
            createTreeNodesRecursive(itemNode.__children, childrenUl);
        }
    }
}

/** Adds event listeners to the dynamically generated tree using event delegation. */
function addTreeEventListeners() {
     console.log("[Popup] Adding tree event listeners...");
     // Use event delegation on the container for efficiency
     fileTreeContainer.removeEventListener('change', handleCheckboxChange); // Remove previous listener if any
     fileTreeContainer.removeEventListener('click', handleTreeClick); // Remove previous listener if any

     // Listener for checkbox changes
     fileTreeContainer.addEventListener('change', handleCheckboxChange);
     // Listener for clicks (primarily for toggler)
     fileTreeContainer.addEventListener('click', handleTreeClick);
     console.log("[Popup] Tree event listeners added.");
}

// --- Event Handlers ---
/**
 * Handles checkbox changes in the file tree. Updates selection state,
 * propagates changes to children/parents, persists state, and updates UI.
 * Uses path keys (dataset.path) for identification.
 * @param {Event} event - The change event object.
 */
async function handleCheckboxChange(event) {
    // Ensure the event target is a checkbox within the tree
    if (event.target.type !== 'checkbox' || !event.target.dataset.path) return;

    const checkbox = event.target;
    const pathKey = checkbox.dataset.path; // e.g., "src/file.js" or "src/folder/"
    const isChecked = checkbox.checked; // The new state after the click

    console.log(`[Popup] Checkbox changed: ${pathKey}, New Checked State: ${isChecked}, Was Indeterminate: ${checkbox.indeterminate}`);

    // If checkbox was indeterminate, the 'change' event correctly reflects the new checked state (true).
    // We just need to clear the indeterminate visual state.
    if (checkbox.indeterminate) {
        checkbox.indeterminate = false;
    }

    // --- 1. Update self and descendants (if folder) ---
    selectionState[pathKey] = isChecked;

    const isFolder = pathKey.endsWith('/');
    if (isFolder) {
        const descendants = getDescendantPaths(pathKey);
        descendants.forEach(descendantPathKey => {
            // Only update state if it differs, though overwriting is usually fine
            if (selectionState[descendantPathKey] !== isChecked) {
                 selectionState[descendantPathKey] = isChecked;
            }
            // Update corresponding checkbox in the DOM if it exists
            const descendantCheckbox = fileTreeContainer.querySelector(`input[type="checkbox"][data-path="${CSS.escape(descendantPathKey)}"]`);
            if (descendantCheckbox) {
                descendantCheckbox.checked = isChecked;
                descendantCheckbox.indeterminate = false; // Children inherit definite state
            }
        });
        console.log(`[Popup] Propagated check state (${isChecked}) to ${descendants.length} descendants of ${pathKey}`);
    }

    // --- 2. Update parent states (upwards traversal) ---
    let currentPathKey = pathKey;
    let parentPathKey = getParentFolderPath(currentPathKey);
    while (parentPathKey) {
        const parentCheckbox = fileTreeContainer.querySelector(`input[type="checkbox"][data-path="${CSS.escape(parentPathKey)}"]`);
        if (!parentCheckbox) {
             console.warn(`[Popup] Could not find parent checkbox DOM element for path: ${parentPathKey}`);
             break; // Stop traversal if parent element not found
        }

        // Find direct children of this parent to determine its state
        // Note: getDescendantPaths gets *all* descendants, we need direct children's states.
        // We can filter the keys of selectionState whose parent is the current parentPathKey.
        const directChildrenKeys = Object.keys(selectionState).filter(k => getParentFolderPath(k) === parentPathKey);

        if (directChildrenKeys.length === 0) {
             // This parent has no children in the current state map (might be an empty folder).
             // Its state should just be its own value (likely true if defaulted, or what it was loaded as).
             // In theory, this state should already be correct unless loading logic failed. Let's ensure it reflects the checkbox.
             console.warn(`[Popup] Parent folder ${parentPathKey} has no tracked children. Assuming state based on checkbox.`);
             selectionState[parentPathKey] = parentCheckbox.checked; // Reflect current visual state if no children data
             parentCheckbox.indeterminate = false; // Cannot be indeterminate if no children
        } else {
            const childrenStates = directChildrenKeys.map(k => ({ state: selectionState[k], checkbox: fileTreeContainer.querySelector(`input[type="checkbox"][data-path="${CSS.escape(k)}"]`) }));

            const allChecked = childrenStates.every(cs => cs.state === true && !cs.checkbox?.indeterminate);
            // Consider a child 'unchecked' if its state is false AND it's not indeterminate.
            // Indeterminate children mean the parent must also be indeterminate.
            const noneChecked = childrenStates.every(cs => cs.state === false && !cs.checkbox?.indeterminate);
            const anyIndeterminate = childrenStates.some(cs => cs.checkbox?.indeterminate);

            if (anyIndeterminate || (!allChecked && !noneChecked)) {
                 // If any child is indeterminate, or if states are mixed, parent is indeterminate.
                 selectionState[parentPathKey] = false; // Store false for indeterminate state
                 parentCheckbox.checked = false;
                 parentCheckbox.indeterminate = true;
                 console.log(`[Popup] Parent folder ${parentPathKey} set to indeterminate.`);
            } else if (allChecked) {
                selectionState[parentPathKey] = true;
                parentCheckbox.checked = true;
                parentCheckbox.indeterminate = false;
                console.log(`[Popup] Parent folder ${parentPathKey} set to checked.`);
            } else { // Must be noneChecked if not allChecked and not indeterminate/mixed
                selectionState[parentPathKey] = false;
                parentCheckbox.checked = false;
                parentCheckbox.indeterminate = false;
                 console.log(`[Popup] Parent folder ${parentPathKey} set to unchecked.`);
            }
        }

        // Move up to the next parent
        parentPathKey = getParentFolderPath(parentPathKey);
    }

    // --- 3. Recalculate totals & Update UI ---
    calculateSelectedTotals();
    updateSelectionInfo(); // Updates counts, size, and Copy button state

    // --- 4. Persist the updated state (Debounce this? Maybe not needed for checkbox changes) ---
    try {
        console.log("[Popup] Persisting updated selection state...");
        const success = await setRepoSelectionState(currentRepoUrl, selectionState);
        if (!success) {
            // Log error, maybe show temporary warning without blocking user
            console.error("[Popup] Failed to persist selection state.");
            showStatus("Warning: Could not save selection state.", true); // Use status as temporary warning
            setTimeout(clearMessages, 3000);
        } else {
             console.log("[Popup] Selection state persisted successfully.");
        }
    } catch (error) {
        console.error("[Popup] Error persisting selection state:", error);
         showStatus("Warning: Error saving selection state.", true); // Use status as temporary warning
         setTimeout(clearMessages, 3000);
    }
}


/**
 * Handles clicks within the tree container, specifically for toggling folders.
 * @param {Event} event - The click event object.
 */
function handleTreeClick(event) {
    // Find the closest ancestor which is a toggler span
    const toggler = event.target.closest('.toggler');

    // Check if the click was on a valid toggler inside a folder list item
    if (toggler && toggler.parentElement.closest('.tree-node.folder')) {
        const nodeLi = toggler.closest('.tree-node.folder');
        // Only toggle if the folder actually has children visually represented
        const childrenUl = nodeLi.querySelector('.tree-node-children');

        if (nodeLi && childrenUl) { // Ensure it's a folder meant to be toggled
             console.log(`[Popup] Toggler clicked for: ${nodeLi.dataset.path}`);
            const isCollapsed = nodeLi.classList.toggle('collapsed'); // Toggle class
            toggler.textContent = isCollapsed ? '▶' : '▼'; // Update icon ('▸'/'▾' or '►'/'▼')
        }
    }
    // Note: We don't need to handle label clicks separately, as the 'for' attribute
    // correctly triggers the 'change' event on the associated checkbox.
}


// --- Action Button Handlers ---
/** Handles the click on the "Copy Context" button. */
async function handleCopyClick() {
    console.log("[Popup] Copy button clicked.");
    if (copyButton.disabled) {
        console.warn("[Popup] Copy button clicked while disabled.");
        return;
    }

    disableControls(); // Disable buttons during copy operation
    refreshButton.disabled = false; // Keep refresh active
    const originalButtonHTML = copyButton.innerHTML; // Store full HTML
    copyButton.innerHTML = `<span class="icon">🕒</span> Copying...`; // Update icon and text
    clearMessages();
    showStatus("Preparing list of files to fetch...");

    const selectedFilesToFetch = [];
    // Iterate through selectionState to find checked files (not folders)
    for (const pathKey in selectionState) {
        if (selectionState[pathKey] === true && !pathKey.endsWith('/')) {
            // Find the corresponding file data to get the SHA
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
         copyButton.innerHTML = originalButtonHTML; // Reset button text/icon
         copyButton.disabled = true; // Keep disabled as 0 files selected
         expandAllButton.disabled = fileTreeData.length === 0; // Re-enable expand/collapse
         collapseAllButton.disabled = fileTreeData.length === 0;
         return;
     }

    let formattedContext = "";
    let filesProcessed = 0;
    let fetchErrors = 0;
    const totalToFetch = selectedFilesToFetch.length;
    const startTime = performance.now();
    showStatus(`Fetching content for ${totalToFetch} files... (0/${totalToFetch})`);

    try {
        // Sort files by path before fetching/formatting for consistent output
        selectedFilesToFetch.sort((a, b) => a.path.localeCompare(b.path));

        // Fetch all contents concurrently
        const contentPromises = selectedFilesToFetch.map(file =>
            getFileContentBySha(currentOwner, currentRepo, file.sha)
                .then(content => {
                    filesProcessed++;
                    // Update status periodically, not on every single file for performance
                    if (filesProcessed % 5 === 0 || filesProcessed === totalToFetch) {
                        showStatus(`Fetching file contents... (${filesProcessed}/${totalToFetch})`);
                    }
                    return { path: file.path, content: content };
                })
                .catch(error => {
                    console.error(`[Popup] Failed to fetch content for ${file.path} (SHA: ${file.sha}):`, error);
                    fetchErrors++;
                    filesProcessed++; // Still count as processed (attempted)
                     if (filesProcessed % 5 === 0 || filesProcessed === totalToFetch) {
                        showStatus(`Fetching file contents... (${filesProcessed}/${totalToFetch})`);
                    }
                    // Return error marker instead of content
                    return { path: file.path, error: error.message || "Unknown error" };
                })
        );

        const results = await Promise.all(contentPromises);
        const endTime = performance.now();
        console.log(`[Popup] Content fetching completed in ${((endTime - startTime) / 1000).toFixed(2)}s.`);

        showStatus("Formatting context..."); // Update status

        // Format the results (already sorted)
        results.forEach(result => {
            if (result.content !== undefined) {
                // Basic sanitization: Replace null bytes which can cause issues
                const sanitizedContent = result.content.replace(/\0/g, ''); // Replace null bytes
                // Add file header and content
                formattedContext += `// file path: ${result.path}\n`;
                formattedContext += `${sanitizedContent}\n\n`; // Add double newline separator
            } else {
                 // Log skipped files due to error (already logged during fetch)
                 console.warn(`[Popup] Skipping file in final output due to fetch error: ${result.path}`);
            }
        });

        // Remove the final two newlines for cleaner output
        formattedContext = formattedContext.trimEnd();

        // Determine success/failure message
        const filesCopied = totalToFetch - fetchErrors;
        let finalMessage;
        let messageIsWarning = false;

        if (filesCopied > 0) {
            finalMessage = `Context for ${filesCopied} file(s) copied!`;
            if (fetchErrors > 0) {
                finalMessage += ` (${fetchErrors} failed)`;
                messageIsWarning = true; // Mark as warning if some failed
            }
        } else if (fetchErrors > 0) {
            finalMessage = `Copy failed: Could not retrieve content for any of the ${fetchErrors} selected files.`;
            messageIsWarning = true; // Treat as error/warning
        } else {
            // Should not happen if selectedFilesToFetch > 0, but handle defensively
            finalMessage = "Copy failed: No content generated.";
            messageIsWarning = true;
        }


        if (filesCopied > 0 && formattedContext) { // Only copy if there's actual content
            await navigator.clipboard.writeText(formattedContext);
            console.log("[Popup] Formatted context copied to clipboard.");
            showStatus(finalMessage, messageIsWarning); // Show success/partial success
        } else {
            // Handle case where all files failed or generated empty context
            showError(finalMessage); // Show error message
        }

        // System notification (optional, check permission)
        try {
            // Check if permission exists before trying to use it
            const hasNotificationPermission = await chrome.permissions.contains({ permissions: ['notifications'] });
            if(hasNotificationPermission) {
                 chrome.notifications.create({
                     type: 'basic',
                     iconUrl: chrome.runtime.getURL('icons/icon48.png'), // Ensure icons path is correct
                     title: 'GitHub AI Context Builder',
                     message: finalMessage
                 });
            } else {
                console.log("[Popup] Notification permission not granted, skipping notification.");
            }
        } catch (notifyError) {
             console.warn("[Popup] Could not create notification:", notifyError);
        }

    } catch (error) {
        // Catch errors from Promise.all or clipboard write
        console.error("[Popup] Error during copy process:", error);
        showError(`Copy failed unexpectedly: ${error.message}`);
    } finally {
        // Reset button state AFTER potential async operations (clipboard, notifications)
        copyButton.innerHTML = originalButtonHTML;
        // Re-enable buttons based on current state
        copyButton.disabled = totalSelectedFiles === 0;
        expandAllButton.disabled = fileTreeData.length === 0;
        collapseAllButton.disabled = fileTreeData.length === 0;
        refreshButton.disabled = false;
    }
}

/** Handles the click on the "Refresh" button. */
function handleRefreshClick() {
    console.log("[Popup] Refresh button clicked.");
    // Clear UI elements and state before re-initializing
    clearMessages();
    fileTreeContainer.innerHTML = ''; // Clear tree immediately
    repoTitleElement.textContent = "Refreshing...";
    disableControls(); // Disable controls while refreshing

    // Reset state variables (redundant with initializePopup start, but explicit)
    selectionState = {};
    fileTreeData = [];
    treeHierarchy = {};
    totalSelectedFiles = 0;
    totalSelectedSize = 0;
    isTruncated = false;
    updateSelectionInfo(); // Update UI to show 0/disabled buttons

    initializePopup(); // Start the load process again
}

/** Handles the click on the "Expand All" button. */
function handleExpandAll() {
    console.log("[Popup] Expand All clicked.");
    const togglers = fileTreeContainer.querySelectorAll('.tree-node.folder .toggler');
    togglers.forEach(toggler => {
        const nodeLi = toggler.closest('.tree-node.folder');
        // Only expand if it's actually expandable (has children UL) and is currently collapsed
        if (nodeLi && nodeLi.querySelector('.tree-node-children') && nodeLi.classList.contains('collapsed')) {
            nodeLi.classList.remove('collapsed');
            toggler.textContent = '▼'; // Update icon
        }
    });
}

/** Handles the click on the "Collapse All" button. */
function handleCollapseAll() {
     console.log("[Popup] Collapse All clicked.");
     const togglers = fileTreeContainer.querySelectorAll('.tree-node.folder .toggler');
     togglers.forEach(toggler => {
        const nodeLi = toggler.closest('.tree-node.folder');
         // Only collapse if it's actually expandable (has children UL) and is not currently collapsed
        if (nodeLi && nodeLi.querySelector('.tree-node-children') && !nodeLi.classList.contains('collapsed')) {
            nodeLi.classList.add('collapsed');
            toggler.textContent = '▶'; // Update icon
        }
    });
}


// --- Attach Event Listeners ---
// Initialize popup once the DOM is fully loaded
document.addEventListener('DOMContentLoaded', initializePopup);

// Attach listeners for header/control buttons
copyButton.addEventListener('click', handleCopyClick);
refreshButton.addEventListener('click', handleRefreshClick);
expandAllButton.addEventListener('click', handleExpandAll);
collapseAllButton.addEventListener('click', handleCollapseAll);

// Tree listeners are attached dynamically after render in addTreeEventListeners()

console.log("[Popup] Script loaded and ready.");