// --------------- SPACE TOOLBAR BUTTON ------
async function createSpaceButton() {
  try {
    let spaceName = "Archibald";
    let defaultUrl = browser.runtime.getURL("content/archibald.html");

    let isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    let iconPrefix = isDark ? "dark" : "light";

    let buttonProperties = {
      title: "Archivage de boîte à lettres",
      defaultIcons: {
        "18": "skin/images/archibald_logo_18_"+iconPrefix+".png",
        "32": "skin/images/archibald_logo_32_"+iconPrefix+".png"
      }
    };

    let space = await browser.spaces.create(spaceName, defaultUrl, buttonProperties);
    console.log(`Archibald button created with space ID: ${space.id}`);
  } catch (error) {
    console.error("Error creating space:", error);
  }
}
createSpaceButton();
// -------------------------------------------