//#region service-worker-lifecycle/wake.ts
chrome.runtime.sendMessage({ type: "stagehand_wake_service_worker" }, () => void chrome.runtime.lastError);
//#endregion
