// Opens Archibald in a tab
async function openOrFocusArchibaldTab()
{
  await messenger.runtime.openOptionsPage();
}

// background.js (loaded via manifest v3)
function archibaldInit()
{
  //console.log("[Archibald] - Archibald background loaded.");
  browser.archibaldApi.init();

  browser.archibaldApi.onArchive.removeListener(messageListener);
  browser.archibaldApi.onArchive.addListener(messageListener);

  messenger.action.onClicked.removeListener(openOrFocusArchibaldTab);
  messenger.action.onClicked.addListener(openOrFocusArchibaldTab);
}

// Listens for Thunderbird archive requests
function messageListener(messages)
{
  console.log("[Archibald] - Background received data from implementation:", messages);
  openArchibaldWithData(messages);
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
browser.runtime.onStartup.addListener(() => archibaldInit());
browser.runtime.onInstalled.addListener(() => archibaldInit());
archibaldInit();
setInterval(() => { archibaldInit(); }, 10000);

// Opens Archibald in a tab, passing through a Thunderbird archive request
async function openArchibaldWithData(messages)
{
  await browser.storage.local.set({ "thunderbirdRequest": messages });
  await browser.runtime.openOptionsPage();
}