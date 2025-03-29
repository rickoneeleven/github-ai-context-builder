// file path: options/options.js
console.log("[Options] options.js script starting...");

// Import the necessary storage functions from the common module
import { getGitHubPat, setGitHubPat } from '../common/storage.js';

// Get references to the DOM elements
const patInput = document.getElementById('pat');
const saveButton = document.getElementById('save');
const statusElement = document.getElementById('status');

/**
 * Displays a status message to the user and clears it after a delay.
 * @param {string} message The message to display.
 * @param {boolean} [isError=false] If true, applies error styling.
 */
function showStatus(message, isError = false) {
    console.log(`[Options Status] ${isError ? 'Error: ' : ''}${message}`);
    statusElement.textContent = message;
    // Apply CSS classes for styling based on success/error
    statusElement.className = isError ? 'status-error' : 'status-success';

    // Clear the message after 3 seconds
    setTimeout(() => {
        statusElement.textContent = '';
        statusElement.className = ''; // Clear class as well
    }, 3000);
}

/**
 * Handles the click event for the Save button.
 * Reads the PAT from the input, attempts to save it using setGitHubPat,
 * and displays feedback to the user.
 */
async function handleSaveClick() {
    const patValue = patInput.value.trim(); // Get trimmed value from input
    console.log("[Options] Save button clicked. Attempting to save PAT.");

    // Provide immediate feedback
    statusElement.textContent = 'Saving...';
    statusElement.className = ''; // Reset styling

    try {
        const success = await setGitHubPat(patValue);
        if (success) {
            console.log("[Options] PAT saved successfully via setGitHubPat.");
            showStatus('Token saved successfully!', false);
        } else {
            // setGitHubPat should log specific errors, but we show a generic UI error
            console.error("[Options] Failed to save PAT (setGitHubPat returned false).");
            showStatus('Failed to save token. Check background script console for details.', true);
        }
    } catch (error) {
        // Catch any unexpected errors during the async operation
        console.error("[Options] Exception while trying to save PAT:", error);
        showStatus(`Error saving token: ${error.message}`, true);
    }
}

/**
 * Loads the currently stored PAT (if any) when the options page is opened
 * and populates the input field.
 */
async function loadExistingPat() {
    console.log("[Options] Options page loaded. Attempting to load existing PAT.");
    try {
        const currentPat = await getGitHubPat();
        if (currentPat) {
            patInput.value = currentPat;
            console.log("[Options] Existing PAT loaded into input field.");
        } else {
            console.log("[Options] No existing PAT found in storage.");
            patInput.value = ''; // Ensure field is empty if no PAT stored
        }
    } catch (error) {
        console.error("[Options] Error loading existing PAT:", error);
        showStatus(`Error loading saved token: ${error.message}`, true);
        patInput.value = ''; // Ensure field is empty on error
    }
}

// --- Attach Event Listeners ---

// Add listener to the Save button
saveButton.addEventListener('click', handleSaveClick);

// Add listener to load the PAT when the page finishes loading
document.addEventListener('DOMContentLoaded', loadExistingPat);

console.log("[Options] options.js script loaded and listeners attached.");