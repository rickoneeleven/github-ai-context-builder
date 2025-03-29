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
            throw new Error("Could not get active tab information.");
        }

        currentRepoUrl = tabs[0].url;
        console.log(`[Popup] Current URL: ${currentRepoUrl}`);

        const repoInfo = parseRepoUrl(currentRepoUrl);
        if (!repoInfo) {
            throw new Error("Could not parse GitHub repository details from URL. Ensure you are on a GitHub repository page.");
        }

        currentOwner = repoInfo.owner;
        currentRepo = repoInfo.repo;
        repoTitleElement.textContent = `${currentOwner}/${currentRepo}`;
        repoTitleElement.title = `${currentOwner}/${currentRepo}`; // Add tooltip

        // Disable buttons initially
        copyButton.disabled = true;
        expandAllButton.disabled = true;
        collapseAllButton.disabled = true;
        refreshButton.disabled = true; // Disable refresh until initial load finishes

        await loadRepoData();

        const endTime = performance.now();
        perfStatsElement.textContent = `Load time: ${((endTime - startTime) / 1000).toFixed(2)}s`;
        refreshButton.disabled = false; // Re-enable refresh after load

    } catch (error) {
        console.error("[Popup] Initialization failed:", error);
        showError(`Initialization failed: ${error.message}`);
        repoTitleElement.textContent = "Error Loading";
        if(loadingIndicator) loadingIndicator.style.display = 'none'; // Hide loading
        refreshButton.disabled = false; // Still allow refresh on error
    }
}

/**
 * Fetches repository tree data, loads selection state, and renders the file tree.
 */
async function loadRepoData() {
    console.log(`[Popup] Loading repository data for ${currentOwner}/${currentRepo}`);
    showStatus(`Fetching file tree for ${currentOwner}/${currentRepo}...`);
    if(loadingIndicator) loadingIndicator.style.display = 'block';
    fileTreeContainer.innerHTML = ''; // Clear previous tree (if any) before loading indicator
    fileTreeContainer.appendChild(loadingIndicator); // Ensure loading is visible
    isTruncated = false; // Reset truncation flag
    // Reset totals before load
    totalSelectedFiles = 0;
    totalSelectedSize = 0;

    try {
        // Fetch the tree structure
        // TODO: Modify getRepoTree in github_api.js to return { tree: [], truncated: boolean }
        // For now, assume it just returns the array and sets a global or logs warning.
        const rawTree = await getRepoTree(currentOwner, currentRepo);
        // isTruncated = result.truncated; // Assuming getRepoTree returns object
        fileTreeData = rawTree.filter(item => item.type === 'blob' || item.type === 'tree');
        console.log(`[Popup] Received ${fileTreeData.length} tree items.`);

        if (fileTreeData.length === 0) {
           showStatus("Repository appears to be empty or inaccessible.", true);
           if(loadingIndicator) loadingIndicator.style.display = 'none';
           return;
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
                    selectionState[key] = true;
                }
            });

        } else {
            console.log("[Popup] No persisted state found, defaulting to all selected.");
            selectionState = {};
            fileTreeData.forEach(item => {
                const key = item.type === 'tree' ? `${item.path}/` : item.path;
                selectionState[key] = true;
            });
        }

        // Build the hierarchical structure and render the tree
        renderFileTree(); // Renders based on selectionState

        // Calculate totals based on the loaded/default state BEFORE updating UI info
        calculateSelectedTotals();
        updateSelectionInfo(); // Updates counts, size, and button states

        // Enable controls now that tree is loaded
        expandAllButton.disabled = false;
        collapseAllButton.disabled = false;
        // Copy button state is set inside updateSelectionInfo

        clearMessages(); // Clear "Loading..." message
        if (isTruncated) { // Check the flag
            showStatus("Warning: Repository tree is large and may be incomplete.", true);
        }

    } catch (error) {
        console.error("[Popup] Failed to load repository data:", error);
        showError(`Error loading data: ${error.message}. Check console for details.`);
        if(loadingIndicator) loadingIndicator.style.display = 'none';
        // Ensure essential buttons are still potentially usable
        expandAllButton.disabled = true;
        collapseAllButton.disabled = true;
        copyButton.disabled = true;
    }
}

// --- Helper Functions ---
/**
 * Finds all descendant paths (files and folders) for a given folder path within the flat fileTreeData.
 * @param {string} folderPath - The path of the folder (e.g., "src/utils/"). Must end with '/'.
 * @returns {string[]} - An array of full paths for all descendants (using pathKey format).
 */
function getDescendantPaths(folderPath) {
    if (!folderPath.endsWith('/')) {
        console.warn("[Popup] getDescendantPaths called with non-folder path:", folderPath);
        return [];
    }
    const descendants = [];
    for (const item of fileTreeData) {
        // Check if item.path starts with the folderPath (prefix check)
        // AND is not the folder itself (item.path should be longer or different)
        if (item.path.startsWith(folderPath.slice(0,-1)) && item.path !== folderPath.slice(0,-1)) {
             // Ensure it's truly within the folder path segments
             const itemParts = item.path.split('/');
             const folderParts = folderPath.slice(0,-1).split('/');
             if (itemParts.length > folderParts.length && item.path.startsWith(folderPath)) {
                 const key = item.type === 'tree' ? `${item.path}/` : item.path;
                 descendants.push(key);
             } else if (itemParts.length === folderParts.length && item.path === folderPath.slice(0,-1)) {
                 // This case handles the folder itself, which we don't want as a descendant
                 continue;
             }
        }
    }
    // console.log(`[Popup] Descendants for ${folderPath}:`, descendants); // Verbose
    return descendants;
}

/**
 * Finds the parent folder path for a given path.
 * @param {string} itemPathKey - The path key of the file or folder (e.g., "src/utils/helpers.js" or "src/utils/").
 * @returns {string | null} - The parent folder path key ending with '/', or null if it's a root item.
 */
function getParentFolderPath(itemPathKey) {
    const path = itemPathKey.endsWith('/') ? itemPathKey.slice(0, -1) : itemPathKey; // Remove trailing slash for splitting
    const parts = path.split('/');
    if (parts.length <= 1) {
        return null; // Root level item
    }
    // Join all parts except the last one, add trailing slash
    return parts.slice(0, -1).join('/') + '/';
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
            const fileData = fileTreeData.find(item => item.path === pathKey && item.type === 'blob');
            if (fileData && typeof fileData.size === 'number') {
                count++;
                size += fileData.size;
            } else if (fileData) {
                console.warn(`[Popup] File data found for ${pathKey} but size is missing or invalid:`, fileData.size);
            } else {
                 console.warn(`[Popup] No file data found in fileTreeData for selected path: ${pathKey}. State might be stale.`);
            }
        }
    }

    totalSelectedFiles = count;
    totalSelectedSize = size;
    console.log(`[Popup] Calculation complete: ${totalSelectedFiles} files, ${formatBytes(totalSelectedSize)}`);
}

// --- UI Update Functions ---
/**
 * Displays a status message to the user.
 * @param {string} message The message to display.
 * @param {boolean} [isWarning=false] If true, uses error styling but it's just a status.
 */
function showStatus(message, isWarning = false) {
    console.log(`[Popup Status] ${message}`);
    errorMessageElement.classList.add('hidden');
    statusMessageElement.textContent = message;
    statusMessageElement.className = isWarning ? 'status error' : 'status';
    statusMessageElement.classList.remove('hidden');
}

/**
 * Displays an error message to the user.
 * @param {string} message The error message to display.
 */
function showError(message) {
    console.error(`[Popup Error] ${message}`);
    statusMessageElement.classList.add('hidden');
    errorMessageElement.textContent = message;
    errorMessageElement.classList.remove('hidden');
}

/**
 * Clears any currently displayed status or error messages.
 */
function clearMessages() {
    statusMessageElement.classList.add('hidden');
    errorMessageElement.classList.add('hidden');
    statusMessageElement.textContent = '';
    errorMessageElement.textContent = '';
}

/**
 * Updates the display of selected file count and total size.
 * Assumes calculateSelectedTotals() has been called before this.
 */
function updateSelectionInfo() {
    selectedCountElement.textContent = `Selected: ${totalSelectedFiles} files`;
    selectedSizeElement.textContent = `Total Size: ${formatBytes(totalSelectedSize)}`;
    copyButton.disabled = (totalSelectedFiles === 0);
    console.log(`[Popup] UI selection info updated: ${totalSelectedFiles} files, ${formatBytes(totalSelectedSize)}`);
}

/**
 * Formats bytes into a human-readable string (B, KB, MB, GB).
 * @param {number} bytes The number of bytes.
 * @param {number} [decimals=2] The number of decimal places.
 * @returns {string} Formatted string.
 */
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0 || !bytes) return '0 B'; // Handle null/undefined bytes
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    // Handle potential log(0) or negative numbers if input is weird
    if (bytes <= 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    // Ensure i is within bounds of sizes array
    const index = Math.min(i, sizes.length - 1);
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

            if (isLastPart) {
                // It's the actual file or folder described by 'item'
                if (!currentLevel[part]) { // Ensure node exists
                    currentLevel[part] = {};
                }
                currentLevel[part].__data = item;
                currentLevel[part].__children = item.type === 'tree' ? {} : null;
            } else {
                // It's an intermediate folder segment
                if (!currentLevel[part]) {
                    // Create folder node implicitly if it doesn't exist
                    console.warn(`[Popup] Creating implicit folder node for: ${part} in path ${item.path}`);
                    // Synthesize minimal folder data
                    currentLevel[part] = {
                         __data: { path: currentPathSegment, type: 'tree' }, // Use reconstructed path
                         __children: {}
                    };
                } else if (!currentLevel[part].__children) {
                     // Ensure existing node has a children object if it's meant to be a folder
                     console.warn(`[Popup] Adding missing __children to existing node: ${part}`);
                     currentLevel[part].__children = {};
                     // Ensure it's marked as type 'tree' if it wasn't already
                     if(!currentLevel[part].__data || currentLevel[part].__data.type !== 'tree') {
                         currentLevel[part].__data = { ...(currentLevel[part].__data || {}), path: currentPathSegment, type: 'tree' };
                     }
                }
                currentLevel = currentLevel[part].__children;
            }
        }
    }
    return tree;
}


/**
 * Renders the file tree HTML based on the hierarchical data.
 */
function renderFileTree() {
    console.log("[Popup] Rendering file tree...");
    if(loadingIndicator) loadingIndicator.style.display = 'none';
    fileTreeContainer.innerHTML = '';

    treeHierarchy = buildTreeHierarchy(fileTreeData);

    const rootElement = document.createElement('ul');
    rootElement.className = 'tree-root';
    rootElement.style.paddingLeft = '0'; // Remove default UL padding
    rootElement.style.listStyle = 'none'; // Remove default UL bullets

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
    const keys = Object.keys(node).sort((a, b) => {
        const nodeA = node[a];
        const nodeB = node[b];
        // Sort folders before files, then alphabetically
        const typeA = nodeA.__data && nodeA.__data.type === 'tree' ? 0 : 1;
        const typeB = nodeB.__data && nodeB.__data.type === 'tree' ? 0 : 1;
        if (typeA !== typeB) return typeA - typeB;
        return a.localeCompare(b);
    });

    for (const key of keys) {
        const itemNode = node[key];
        // Skip if data is somehow missing (though buildTreeHierarchy tries to prevent this)
        if (!itemNode.__data) {
             console.warn(`[Popup] Skipping node render, missing __data for key: ${key}`);
             continue;
        }
        const itemData = itemNode.__data; // { path, type, sha, size }
        const itemPath = itemData.path; // Full path from API
        const isFolder = itemData.type === 'tree';
        const nodeKey = isFolder ? `${itemPath}/` : itemPath; // Key for selectionState

        const li = document.createElement('li');
        li.className = `tree-node ${isFolder ? 'folder' : 'file'}`;
        if (isFolder) li.classList.add('collapsed'); // Default collapsed
        li.dataset.path = nodeKey;

        // --- Checkbox ---
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        const safeId = `cb_${nodeKey.replace(/[^a-zA-Z0-9]/g, '_')}`;
        checkbox.id = safeId;
        // Check selection state, default to true if somehow missing (shouldn't happen after load logic)
        checkbox.checked = selectionState[nodeKey] === true;
        checkbox.dataset.path = nodeKey;

        // Check parent state for initial indeterminate state
        if(!isFolder && checkbox.checked === false){
            // If a file is unchecked, check if its parent should be indeterminate initially
             let parentPath = getParentFolderPath(nodeKey);
             if(parentPath){
                 const parentCheckbox = fileTreeContainer.querySelector(`input[type="checkbox"][data-path="${CSS.escape(parentPath)}"]`);
                 if(parentCheckbox && !parentCheckbox.indeterminate){ // Check if already set indeterminate
                     // Need to check siblings - This might be too complex during initial render.
                     // Let's rely on the logic in handleCheckboxChange to set indeterminate state correctly after user interaction or initial load adjustments.
                 }
             }
        }
         // Set initial indeterminate state for folders based on loaded state
         if (isFolder) {
            const descendants = getDescendantPaths(nodeKey);
            const childrenStates = descendants.map(p => selectionState[p]);
            const allChecked = childrenStates.every(state => state === true);
            const noneChecked = childrenStates.every(state => state === false || state === undefined);
            if (!allChecked && !noneChecked) {
                checkbox.indeterminate = true;
                 // Ensure checked is false if indeterminate
                 checkbox.checked = false;
                 selectionState[nodeKey] = false; // Store false for indeterminate state
            } else {
                 checkbox.checked = allChecked; // True if all checked, false if none checked
                 selectionState[nodeKey] = allChecked; // Store actual state
            }
         }


        // --- Label ---
        const label = document.createElement('label');
        label.htmlFor = safeId;

        // Toggler
        if (isFolder) {
            const toggler = document.createElement('span');
            toggler.className = 'toggler';
            toggler.textContent = '▶';
            toggler.title = "Expand/Collapse";
            label.appendChild(toggler);
        } else {
             const spacer = document.createElement('span');
             spacer.className = 'toggler';
             spacer.innerHTML = ' ';
             label.appendChild(spacer);
        }

        // Icon
        const icon = document.createElement('span');
        icon.className = 'node-icon';
        icon.textContent = isFolder ? '📁' : '📄';
        label.appendChild(icon);

        // Name
        const nameSpan = document.createElement('span');
        nameSpan.className = 'node-name';
        nameSpan.textContent = key;
        nameSpan.title = itemPath;
        label.appendChild(nameSpan);

        // Meta
        const metaSpan = document.createElement('span');
        metaSpan.className = 'node-meta';
        if (!isFolder && itemData.size !== undefined) {
            metaSpan.textContent = formatBytes(itemData.size);
        }
        label.appendChild(metaSpan);

        li.appendChild(checkbox);
        li.appendChild(label);
        parentElement.appendChild(li);

        // --- Children ---
        if (isFolder && itemNode.__children && Object.keys(itemNode.__children).length > 0) {
            const childrenUl = document.createElement('ul');
            childrenUl.className = 'tree-node-children';
            childrenUl.style.paddingLeft = '20px'; // Indentation for children
            childrenUl.style.listStyle = 'none';
            li.appendChild(childrenUl);
            createTreeNodesRecursive(itemNode.__children, childrenUl);
        }
    }
}

/**
 * Adds event listeners to the dynamically generated tree.
 */
function addTreeEventListeners() {
     console.log("[Popup] Adding tree event listeners...");
     // Use event delegation on the container
     fileTreeContainer.removeEventListener('change', handleCheckboxChange); // Remove previous listener if any
     fileTreeContainer.removeEventListener('click', handleTreeClick); // Remove previous listener if any
     fileTreeContainer.addEventListener('change', handleCheckboxChange);
     fileTreeContainer.addEventListener('click', handleTreeClick);
     console.log("[Popup] Tree event listeners added.");
}

// --- Event Handlers ---
/**
 * Handles checkbox changes in the file tree. Updates selection state,
 * propagates changes to children/parents, persists state, and updates UI.
 * @param {Event} event - The change event object.
 */
async function handleCheckboxChange(event) {
    if (event.target.type !== 'checkbox') return;

    const checkbox = event.target;
    const pathKey = checkbox.dataset.path;
    let isChecked = checkbox.checked; // Initial user action state

    // If checkbox was indeterminate, the first click should make it checked.
    // The 'change' event reflects the NEW state (checked=true), so this logic is okay.
    if (checkbox.indeterminate) {
        // isChecked = true; // It will already be true from the event
        checkbox.indeterminate = false; // Clear indeterminate state explicitly
         console.log(`[Popup] Indeterminate checkbox clicked, setting state to checked for: ${pathKey}`);
    }


    console.log(`[Popup] Checkbox changed: ${pathKey}, New Checked State: ${isChecked}`);

    // --- 1. Update self and descendants ---
    selectionState[pathKey] = isChecked;
    checkbox.indeterminate = false; // Ensure indeterminate is cleared on direct interaction

    const isFolder = pathKey.endsWith('/');
    if (isFolder) {
        const descendants = getDescendantPaths(pathKey);
        descendants.forEach(descendantPath => {
            selectionState[descendantPath] = isChecked;
            const descendantCheckbox = fileTreeContainer.querySelector(`input[type="checkbox"][data-path="${CSS.escape(descendantPath)}"]`);
            if (descendantCheckbox) {
                descendantCheckbox.checked = isChecked;
                descendantCheckbox.indeterminate = false; // Clear indeterminate on children too
            }
        });
        console.log(`[Popup] Propagated check state (${isChecked}) to ${descendants.length} descendants of ${pathKey}`);
    }

    // --- 2. Update parent states (upwards traversal) ---
    let parentPath = getParentFolderPath(pathKey);
    while (parentPath) {
        const parentCheckbox = fileTreeContainer.querySelector(`input[type="checkbox"][data-path="${CSS.escape(parentPath)}"]`);
        if (!parentCheckbox) {
             console.warn(`[Popup] Could not find parent checkbox for path: ${parentPath}`);
             break;
        }

        const siblingsAndSelfInTree = fileTreeData
                                    .filter(item => item.path.startsWith(parentPath.slice(0,-1)) && item.path !== parentPath.slice(0,-1))
                                    .map(item => item.type === 'tree' ? `${item.path}/` : item.path);

        // Filter to direct children by checking path depth? More robust might be needed depending on API behavior.
        // Let's check the state of known direct children based on their paths starting with parentPath
        const directChildrenKeys = Object.keys(selectionState).filter(k => k.startsWith(parentPath) && getParentFolderPath(k) === parentPath);

        if (directChildrenKeys.length === 0) {
             // No children found in state? This shouldn't typically happen if parent exists. Default to checked?
             console.warn(`[Popup] No direct children found in selectionState for parent: ${parentPath}`);
             selectionState[parentPath] = true; // Default parent to true if no children? Or false? Let's say true.
             parentCheckbox.checked = true;
             parentCheckbox.indeterminate = false;

        } else {
            const childrenStates = directChildrenKeys.map(k => selectionState[k]);
            const allChecked = childrenStates.every(state => state === true);
            const noneChecked = childrenStates.every(state => state === false || state === undefined);

            if (allChecked) {
                selectionState[parentPath] = true;
                parentCheckbox.checked = true;
                parentCheckbox.indeterminate = false;
                console.log(`[Popup] Parent folder ${parentPath} set to checked.`);
            } else if (noneChecked) {
                selectionState[parentPath] = false;
                parentCheckbox.checked = false;
                parentCheckbox.indeterminate = false;
                 console.log(`[Popup] Parent folder ${parentPath} set to unchecked.`);
            } else {
                selectionState[parentPath] = false; // Store false for indeterminate
                parentCheckbox.checked = false;
                parentCheckbox.indeterminate = true;
                 console.log(`[Popup] Parent folder ${parentPath} set to indeterminate.`);
            }
        }

        // Move up
        parentPath = getParentFolderPath(parentPath);
    }

    // --- 3. Recalculate totals & Update UI ---
    calculateSelectedTotals();
    updateSelectionInfo();

    // --- 4. Persist the updated state ---
    try {
        console.log("[Popup] Persisting updated selection state...");
        const success = await setRepoSelectionState(currentRepoUrl, selectionState);
        if (!success) {
            console.error("[Popup] Failed to persist selection state.");
            showError("Warning: Could not save selection state.");
            setTimeout(clearMessages, 3000);
        } else {
             console.log("[Popup] Selection state persisted successfully.");
        }
    } catch (error) {
        console.error("[Popup] Error persisting selection state:", error);
         showError("Warning: Error saving selection state.");
         setTimeout(clearMessages, 3000);
    }
}


/**
 * Handles clicks within the tree container, specifically for toggling folders.
 * @param {Event} event - The click event object.
 */
function handleTreeClick(event) {
    const toggler = event.target.closest('.toggler');
    if (toggler && toggler.parentElement.closest('.tree-node.folder')) { // Ensure it's a folder toggler
        const nodeLi = toggler.closest('.tree-node.folder');
        if (nodeLi) {
             console.log(`[Popup] Toggler clicked for: ${nodeLi.dataset.path}`);
            nodeLi.classList.toggle('collapsed');
            toggler.textContent = nodeLi.classList.contains('collapsed') ? '▶' : '▼';
        }
    }
    // Prevent label clicks from toggling checkbox twice if event bubbles
     if (event.target.tagName === 'LABEL' || event.target.closest('label')) {
        // Check if the click was directly on the checkbox itself (handled by 'change')
        if(event.target.type !== 'checkbox'){
            // Could potentially stop propagation if needed, but usually default behavior is fine
            // event.stopPropagation();
        }
     }
}


// --- Action Button Handlers ---
/**
 * Handles the click on the "Copy Context" button.
 */
async function handleCopyClick() {
    console.log("[Popup] Copy button clicked.");
    if (copyButton.disabled) return; // Prevent accidental clicks

    copyButton.disabled = true;
    const originalButtonText = copyButton.innerHTML; // Store full HTML
    copyButton.innerHTML = `<span class="icon">⏳</span> Copying...`; // Update icon and text
    clearMessages(); // Clear previous messages
    showStatus("Fetching file contents...");

    const selectedFilesToFetch = [];
    // Iterate through selectionState to find checked files
    for (const pathKey in selectionState) {
        if (selectionState[pathKey] && !pathKey.endsWith('/')) {
            const fileData = fileTreeData.find(item => item.path === pathKey && item.type === 'blob');
            if (fileData && fileData.sha) {
                selectedFilesToFetch.push({ path: fileData.path, sha: fileData.sha });
            } else {
                 console.warn(`[Popup] Could not find SHA for selected file: ${pathKey}`);
            }
        }
    }

     console.log(`[Popup] Need to fetch content for ${selectedFilesToFetch.length} files.`);

     if (selectedFilesToFetch.length === 0) {
         showError("No files selected to copy.");
         copyButton.innerHTML = originalButtonText; // Reset button text/icon
         // Keep button disabled (handled by updateSelectionInfo implicitly via totalSelectedFiles=0)
         return;
     }

    let formattedContext = "";
    let filesProcessed = 0;
    let fetchErrors = 0;
    const totalToFetch = selectedFilesToFetch.length;

    try {
        // Sort files by path before fetching/formatting for consistent output
        selectedFilesToFetch.sort((a, b) => a.path.localeCompare(b.path));

        const contentPromises = selectedFilesToFetch.map(async file => {
            try {
                const content = await getFileContentBySha(currentOwner, currentRepo, file.sha);
                // Update status periodically, not on every single file for performance
                filesProcessed++;
                if (filesProcessed % 10 === 0 || filesProcessed === totalToFetch) {
                     showStatus(`Fetching file contents... (${filesProcessed}/${totalToFetch})`);
                }
                return { path: file.path, content: content };
            } catch (error) {
                console.error(`[Popup] Failed to fetch content for ${file.path} (SHA: ${file.sha}):`, error);
                fetchErrors++;
                return { path: file.path, error: error.message };
            }
        });

        const results = await Promise.all(contentPromises);

        // Format the results (already sorted)
        results.forEach(result => {
            if (result.content !== undefined) {
                // Basic sanitization: Replace null bytes which can cause issues
                const sanitizedContent = result.content.replace(/\0/g, '');
                formattedContext += `file name: <${result.path}>\n`;
                formattedContext += `${sanitizedContent}\n\n`;
            } else {
                 console.warn(`[Popup] Skipping file due to fetch error: ${result.path}`);
            }
        });

        formattedContext = formattedContext.trim(); // Remove final newline

        if (!formattedContext && fetchErrors === totalToFetch) {
             throw new Error(`Failed to fetch content for all ${fetchErrors} selected files.`);
        }

        const successMessage = `Context for ${totalToFetch - fetchErrors} files copied!`;
        const failMessage = fetchErrors > 0 ? ` (${fetchErrors} failed)` : '';
        let finalMessage = successMessage + failMessage;

        if(formattedContext){ // Only copy if there's actual content
            await navigator.clipboard.writeText(formattedContext);
            console.log("[Popup] Formatted context copied to clipboard.");
            showStatus(finalMessage, fetchErrors > 0); // Show as warning if errors occurred
        } else {
            // Handle case where all files failed but error wasn't thrown above
            finalMessage = `Copy failed: Could not retrieve content for any selected files.`;
            showError(finalMessage);
        }


        // System notification
        try {
             chrome.notifications.create({
                 type: 'basic',
                 iconUrl: chrome.runtime.getURL('icons/icon48.png'),
                 title: 'GitHub AI Context Builder',
                 message: finalMessage
             });
        } catch (notifyError) {
             console.warn("[Popup] Could not create notification:", notifyError);
        }

    } catch (error) {
        console.error("[Popup] Error during copy process:", error);
        showError(`Copy failed: ${error.message}`);
    } finally {
        // Reset button state
        copyButton.innerHTML = originalButtonText;
        copyButton.disabled = (totalSelectedFiles === 0);
        // Clear status message after a delay? Or leave success/error message? Leave it for now.
        // setTimeout(clearMessages, 5000);
    }
}

/**
 * Handles the click on the "Refresh" button.
 */
function handleRefreshClick() {
    console.log("[Popup] Refresh button clicked.");
    clearMessages();
    fileTreeContainer.innerHTML = ''; // Clear tree immediately
    repoTitleElement.textContent = "Refreshing...";
    // Reset state variables before re-initializing
    selectionState = {};
    fileTreeData = [];
    treeHierarchy = {};
    totalSelectedFiles = 0;
    totalSelectedSize = 0;
    updateSelectionInfo(); // Update UI to show 0/disabled buttons
    initializePopup(); // Start the load process again
}

/**
 * Handles the click on the "Expand All" button.
 */
function handleExpandAll() {
    console.log("[Popup] Expand All clicked.");
    const togglers = fileTreeContainer.querySelectorAll('.tree-node.folder .toggler');
    togglers.forEach(toggler => {
        const nodeLi = toggler.closest('.tree-node.folder');
        if (nodeLi && nodeLi.classList.contains('collapsed')) {
            nodeLi.classList.remove('collapsed');
            toggler.textContent = '▼';
        }
    });
}

/**
 * Handles the click on the "Collapse All" button.
 */
function handleCollapseAll() {
     console.log("[Popup] Collapse All clicked.");
     const togglers = fileTreeContainer.querySelectorAll('.tree-node.folder .toggler');
     togglers.forEach(toggler => {
        const nodeLi = toggler.closest('.tree-node.folder');
        if (nodeLi && !nodeLi.classList.contains('collapsed')) {
            nodeLi.classList.add('collapsed');
            toggler.textContent = '▶';
        }
    });
}


// --- Attach Event Listeners ---
document.addEventListener('DOMContentLoaded', initializePopup);
copyButton.addEventListener('click', handleCopyClick);
refreshButton.addEventListener('click', handleRefreshClick);
expandAllButton.addEventListener('click', handleExpandAll);
collapseAllButton.addEventListener('click', handleCollapseAll);
// Tree listeners are attached dynamically after render in addTreeEventListeners()


console.log("[Popup] Script loaded and ready.");