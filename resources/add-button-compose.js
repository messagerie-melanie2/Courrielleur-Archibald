{
    // parametres
    var windowId = window["windowId"];

    //script
    let button = document.createElement("button");
    button.innerHTML = "ouvrir annuaire";
    button.onclick = () => {
        // callback
        openPauline([windowId]);
    }
    console.log(document.body.innerHTML);
    document.body.appendChild(button);
}
