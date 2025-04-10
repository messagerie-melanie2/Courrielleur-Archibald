// --------------- SPACE TOOLBAR BUTTON ------
async function createSpaceButton() {
  try {
    const spaceName = "Archibald";
    const defaultUrl = browser.runtime.getURL("content/archibald.html");
    const buttonProperties = {
      title: "Archivage de boîte à lettres",
      defaultIcons: {
        "24": {
          "light": "skin/images/archibald_logo_24_light.png",
          "dark": "skin/images/archibald_logo_24_dark.png"
        }
      }
    };

    const space = await browser.spaces.create(spaceName, defaultUrl, buttonProperties);
    console.log(`Archibald button created with space ID: ${space.id}`);
  } catch (error) {
    console.error("Error creating space:", error);
  }
}
createSpaceButton();
// -------------------------------------------