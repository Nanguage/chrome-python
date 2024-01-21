console.log("Hello from service-worker.js");

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({
    id: "run-code",
    title: "Run Code in Python Console",
    type: 'normal',
    contexts: ['selection']
  });
});


chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));


chrome.contextMenus.onClicked.addListener(async (item, tab) => {
  const id = item.menuItemId;
  const res = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    function: () => window.getSelection().toString()
  });
  const selection = res[0].result;
  console.log("selection: ", selection);
  if (id === "run-code") {
    chrome.runtime.sendMessage({type: "run-code", data: selection})
  }
});

