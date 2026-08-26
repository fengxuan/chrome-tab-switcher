document.addEventListener("ended", (event) => {
  if (!(event.target instanceof HTMLVideoElement)) return;
  chrome.runtime.sendMessage({ type: "VIDEO_ENDED" }).catch(() => {});
}, true);
