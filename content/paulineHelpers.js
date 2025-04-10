// Simple Replacement for MailServices.makeMimeAddress
function makeMimeAddress(displayName, email)
{
    // If the display name contains special characters or spaces, quote it.
    if (displayName && /[^\w\s]/.test(displayName)) {
        displayName = `"${displayName.replace(/"/g, '\\"')}"`;
    }
    return `${displayName} <${email}>`;
}

// Displays a notification in the bottom right corner
function showNotification(title, message)
{
    browser.notifications.create({
        "type": "basic",
        "iconUrl": browser.runtime.getURL("skin/images/pauline_icon_64.png"), // Path to your icon
        "title": title,
        "message": message
    });
}

// Add mail to recipiendField in compose window
async function addTextToRecipientField(text) {
    let windows = await messenger.windows.getAll();
    for(let currentWindow of windows) {
        if(currentWindow["type"] == "messageCompose"){
            await messenger.domapi.setInputs(
                [{"key": "mailToRecipientField", "value": text}],
                currentWindow.id);
            messenger.domapi.injectScriptInDom("resources/add-recipient.js", currentWindow.id, "", "add-recipient-script");
        }
    }
}