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