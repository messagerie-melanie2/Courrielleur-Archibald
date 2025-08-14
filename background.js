// background.js (loaded via manifest v3)
console.log("Archibald background loaded.");
browser.archibaldApi.init();

/*browser.archibaldApi.onArchiveRequest.addListener((data) => {
  console.log("background.js got from implementation:", data);
  // call any function in background.js here
  doSomethingInBackground(data);
});

function doSomethingInBackground(data) {
  console.log("Doing something in background with:", data);
}*/


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