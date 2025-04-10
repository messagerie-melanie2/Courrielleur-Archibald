// accolades pour nettoyer les variables let à la fin de bloc
{
    // recupere le parametre
    let mail = window["mailToRecipientField"]

    let recipientInput = document.getElementById("toAddrInput");

    recipientInput.value = mail;

    recipientInput.dispatchEvent(new KeyboardEvent("keydown", {
        key: 'Enter',
        code: 'Enter',
        which: 13,
        keyCode: 13,
        charCode: 13,
        bubbles: true,
        cancelable: true,
    }))

    // à la fin de l'execution on dispose du script
    document.getElementById('add-recipient-script').remove();

}
