// background.js (loaded via manifest v3)

function archibaldInit()
{
  console.log("Archibald background loaded.");
  browser.archibaldApi.init();

  browser.archibaldApi.onArchive.addListener((messages) => {
    console.log("Background received data from implementation:", messages);
    openPopupWithData(messages);
  });
}

// Lets be SURE by ANY mean that we are awake and listening
async function waitForMailTabAndRun() {
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (tab.mailTab) {
      archibaldInit();
      return;
    }
  }
  // Wait until a mail tab is created
  browser.tabs.onCreated.addListener(async (tab) => {
    if (tab.mailTab) {
      archibaldInit();
    }
  });
}
waitForMailTabAndRun();
browser.runtime.onStartup.addListener(() => {
  archibaldInit();
});
archibaldInit();

async function openPopupWithData(messages) {
  // Store the data somewhere the popup can read
  chrome.runtime.onMessage.addListener(function listener(request, sender, sendResponse) {
    if (request.type === "getSafeMessages") {
      sendResponse(messages);
      chrome.runtime.onMessage.removeListener(listener);
    }
  });
  await chrome.action.openPopup();
}


// Toolbar Archibald button
/*async function openArchibaldPopup() {
  try {
    const popupUrl = browser.runtime.getURL("content/archibald.html");

    await browser.windows.create({
      url: popupUrl,
      type: "popup",
      width: 500,
      height: 400
    });

    console.log("Archibald popup window opened.");
  } catch (error) {
    console.error("Failed to open Archibald popup:", error);
  }
}

// Set up the click handler for the toolbar button
browser.action.onClicked.addListener(openArchibaldPopup);*/
// ----------------------------------------