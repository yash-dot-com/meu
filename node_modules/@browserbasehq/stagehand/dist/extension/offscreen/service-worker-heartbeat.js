//#region service-worker-lifecycle/heartbeat.ts
var STAGEHAND_SERVICE_WORKER_HEARTBEAT_PORT = "StagehandExtensionServiceWorkerHeartbeat";
var STAGEHAND_SERVICE_WORKER_HEARTBEAT_INTERVAL_MS = 1e3;
var port = null;
function sendServiceWorkerHeartbeat() {
	port?.postMessage({
		type: "StagehandExtensionServiceWorkerHeartbeat",
		at: (/* @__PURE__ */ new Date()).toISOString()
	});
}
function connectServiceWorkerHeartbeatPort() {
	port = chrome.runtime.connect({ name: STAGEHAND_SERVICE_WORKER_HEARTBEAT_PORT });
	port.onDisconnect.addListener(() => {
		port = null;
		setTimeout(connectServiceWorkerHeartbeatPort, 250);
	});
	sendServiceWorkerHeartbeat();
}
connectServiceWorkerHeartbeatPort();
setInterval(sendServiceWorkerHeartbeat, STAGEHAND_SERVICE_WORKER_HEARTBEAT_INTERVAL_MS);
//#endregion
