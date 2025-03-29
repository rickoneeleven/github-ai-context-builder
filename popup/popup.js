// File: popup/popup.js
import { log } from './popup_utils.js';
import { initializeApp } from './popup_coordinator.js';

console.log("[Popup] Script loading...");

// Document ready event listener
document.addEventListener('DOMContentLoaded', () => {
    log('info', "DOM Content Loaded. Starting application...");
    
    // Initialize the application
    initializeApp();
    
    log('info', "Popup initialization triggered.");
});

log('info', "Popup script loaded.");