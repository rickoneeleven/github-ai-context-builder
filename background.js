import { initVersionChecker } from './common/version-checker.js';

console.log('Background service worker starting...');

initVersionChecker().then(() => {
    console.log('Version checker initialized');
}).catch(error => {
    console.error('Failed to initialize version checker:', error);
});

chrome.runtime.onInstalled.addListener((details) => {
    console.log('Extension installed/updated', details);
});

chrome.runtime.onStartup.addListener(() => {
    console.log('Browser started');
});

// Test change to trigger atomic versioning workflow - 2025-06-16