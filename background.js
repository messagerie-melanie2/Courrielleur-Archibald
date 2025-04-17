// Toolbar Archibald button
async function openArchibaldPopup() {
  try {
    const popupUrl = browser.runtime.getURL("content/archibald.html");

    await browser.windows.create({
      url: popupUrl,
      type: "popup",
      width: 500,
      height: 300
    });

    console.log("Archibald popup window opened.");
  } catch (error) {
    console.error("Failed to open Archibald popup:", error);
  }
}

// Set up the click handler for the toolbar button
browser.browserAction.onClicked.addListener(openArchibaldPopup);
// ----------------------------------------