//var paulineUrl = "https://annuaire-preprod.e2.rie.gouv.fr/";
var paulineUrl = "https://annuaire-preprod.e2.rie.gouv.fr?courrielleur=true"

// --------------- SPACE TOOLBAR BUTTON ------
async function createSpaceButton() {
  try {
    const spaceName = "Pauline";
    const defaultUrl = browser.runtime.getURL("content/pauline.html");
    const buttonProperties = {
      title: "Contacts ministériels",
      defaultIcons: {
        "18": "skin/images/logo-18.png",
        "32": "skin/images/logo-32.png"
      }
    };

    const space = await browser.spaces.create(spaceName, defaultUrl, buttonProperties);
    console.log(`Pauline button created with space ID: ${space.id}`);
  } catch (error) {
    console.error("Error creating space:", error);
  }
}
createSpaceButton();
// -------------------------------------------

// ----------- COMPOSE MAIL BUTTON -----------
async function openPauline(composeWindowId) {
  // TODO: use composeWindowId to add mail only to current window
  let composePaulineUrl = messenger.extension.getURL("content/pauline.html")+ "?compose=true";
  console.log(composePaulineUrl);
  await messenger.windows.create({'type': 'popup', 'url': composePaulineUrl });
}

messenger.composeAction.onClicked.addListener(async (tab) => {
  openPauline(tab.windowId);
});
// -------------------------------------------