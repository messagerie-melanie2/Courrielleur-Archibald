// Toolbar Archibald button
async function openArchibaldPopup() {
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
browser.browserAction.onClicked.addListener(openArchibaldPopup);


async function writeHelloWorld() {
  // Define file path on the local system - adjust the path for your OS
  // Example for Windows: "C:\\Users\\YourUser\\Desktop\\hello.txt"
  // Example for Linux/macOS: "/home/youruser/Desktop/hello.txt"

  // For demonstration, save in the Thunderbird profile folder:
  let path = "C:\\test.txt";

  // Content to write
  let content = "Hello, world!";
  await browser.fileIO.createFile(path, content);
}

// Call the function
writeHelloWorld();
// ----------------------------------------